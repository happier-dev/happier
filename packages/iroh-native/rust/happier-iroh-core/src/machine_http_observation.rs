use super::*;
use tokio::io::{AsyncBufReadExt, BufReader};

pub type MachineHttpObserver =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct MachineHttpObservation {
    pub header_names: Vec<String>,
    pub observer: MachineHttpObserver,
}

pub(super) struct ObservedRequest {
    request_id: u64,
    head: bool,
}

/// Reuse the carrier's existing head budget as a metadata projection boundary.
/// Reaching it stops observation; the caller forwards all bytes unchanged.
async fn read_metadata_line<R: AsyncRead + Unpin>(
    source: &mut BufReader<R>,
    line: &mut Vec<u8>,
    budget: usize,
) -> std::io::Result<bool> {
    while line.len() < budget {
        let available = source.fill_buf().await?;
        if available.is_empty() {
            return Ok(false);
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1)
            .min(budget - line.len());
        let complete = available[length - 1] == b'\n';
        line.extend_from_slice(&available[..length]);
        source.consume(length);
        if complete {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn forward_responses<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    source: &mut R,
    destination: &mut W,
    mut requests: mpsc::UnboundedReceiver<ObservedRequest>,
    observation: &MachineHttpObservation,
    connection_id: u64,
) -> std::io::Result<()> {
    let mut source = BufReader::new(source);
    loop {
        loop {
            let mut head = Vec::new();
            let mut lines = Vec::new();
            loop {
                let mut line = Vec::new();
                let complete = read_metadata_line(
                    &mut source,
                    &mut line,
                    MAX_MACHINE_HTTP_HEAD_BYTES - head.len(),
                )
                .await?;
                head.extend_from_slice(&line);
                if !complete {
                    destination.write_all(&head).await?;
                    tokio::io::copy(&mut source, destination).await?;
                    return Ok(());
                }
                if line == b"\r\n" {
                    break;
                }
                lines.push(line);
            }
            let status = lines
                .first()
                .and_then(|line| std::str::from_utf8(line).ok())
                .filter(|line| line.starts_with("HTTP/1."))
                .and_then(|line| line.split_ascii_whitespace().nth(1))
                .and_then(|status| status.parse::<u16>().ok());
            let Some(status) = status else {
                // Observation must not turn malformed upstream data into a new
                // carrier refusal. Keep the original byte stream unchanged.
                destination.write_all(&head).await?;
                tokio::io::copy(&mut source, destination).await?;
                return Ok(());
            };
            if (100..200).contains(&status) && status != 101 {
                destination.write_all(&head).await?;
                continue;
            }
            let Some(request) = requests.recv().await else {
                destination.write_all(&head).await?;
                tokio::io::copy(&mut source, destination).await?;
                return Ok(());
            };
            let mut headers = serde_json::Map::new();
            let mut content_length = None;
            let mut chunked = false;
            for line in lines.iter().skip(1) {
                let Some(colon) = line.iter().position(|byte| *byte == b':') else {
                    continue;
                };
                let name = &line[..colon];
                let value = line[colon + 1..].trim_ascii();
                if name.eq_ignore_ascii_case(b"content-length") {
                    content_length = std::str::from_utf8(value)
                        .ok()
                        .and_then(|value| value.parse::<u64>().ok());
                }
                if name.eq_ignore_ascii_case(b"transfer-encoding") {
                    chunked = value
                        .split(|byte| *byte == b',')
                        .last()
                        .is_some_and(|coding| coding.trim_ascii().eq_ignore_ascii_case(b"chunked"));
                }
                if let Some(selected) = observation
                    .header_names
                    .iter()
                    .find(|selected| name.eq_ignore_ascii_case(selected.as_bytes()))
                {
                    if let Ok(value) = std::str::from_utf8(value) {
                        headers.insert(selected.to_ascii_lowercase(), value.into());
                    }
                }
            }
            (observation.observer)(serde_json::json!({
                "kind": "response", "connectionId": connection_id.to_string(),
                "requestId": request.request_id.to_string(), "status": status, "headers": headers,
            }).to_string()).await;
            destination.write_all(&head).await?;
            if status == 101 {
                tokio::io::copy(&mut source, destination).await?;
                return Ok(());
            }
            if request.head || status == 204 || status == 304 {
                break;
            }
            if chunked {
                loop {
                    let mut line = Vec::new();
                    let complete =
                        read_metadata_line(&mut source, &mut line, MAX_MACHINE_HTTP_HEAD_BYTES)
                            .await?;
                    destination.write_all(&line).await?;
                    if !complete {
                        tokio::io::copy(&mut source, destination).await?;
                        return Ok(());
                    }
                    let Ok(size) = parse_chunk_size(&line) else {
                        tokio::io::copy(&mut source, destination).await?;
                        return Ok(());
                    };
                    if size == 0 {
                        loop {
                            let mut trailer = Vec::new();
                            let complete = read_metadata_line(
                                &mut source,
                                &mut trailer,
                                MAX_MACHINE_HTTP_HEAD_BYTES,
                            )
                            .await?;
                            destination.write_all(&trailer).await?;
                            if !complete {
                                tokio::io::copy(&mut source, destination).await?;
                                return Ok(());
                            }
                            if trailer == b"\r\n" {
                                break;
                            }
                        }
                        break;
                    }
                    if tokio::io::copy(&mut (&mut source).take(size), destination).await? != size {
                        return Ok(());
                    }
                    let mut delimiter = [0; 2];
                    let mut read = 0;
                    while read < delimiter.len() {
                        let count = source.read(&mut delimiter[read..]).await?;
                        if count == 0 {
                            return Ok(());
                        }
                        destination
                            .write_all(&delimiter[read..read + count])
                            .await?;
                        read += count;
                    }
                    if delimiter != *b"\r\n" {
                        tokio::io::copy(&mut source, destination).await?;
                        return Ok(());
                    }
                }
            } else if let Some(length) = content_length {
                if tokio::io::copy(&mut (&mut source).take(length), destination).await? != length {
                    return Ok(());
                }
            } else {
                tokio::io::copy(&mut source, destination).await?;
                return Ok(());
            }
            break;
        }
    }
}

pub(super) async fn begin_request(
    observation: &MachineHttpObservation,
    connection_id: u64,
    request_id: u64,
    request: &CapabilityGatedHttpRequestHead,
    requests: &mpsc::UnboundedSender<ObservedRequest>,
) {
    (observation.observer)(serde_json::json!({"kind":"request", "connectionId":connection_id.to_string(), "requestId":request_id.to_string()}).to_string()).await;
    let _ = requests.send(ObservedRequest {
        request_id,
        head: request.sanitized.starts_with(b"HEAD "),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pairs_keepalive_response_headers_without_observing_body_or_unselected_headers() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let observation = MachineHttpObservation {
            header_names: vec!["x-broker-code".into()],
            observer: Arc::new({
                let events = events.clone();
                move |event| {
                    events
                        .lock()
                        .unwrap()
                        .push(serde_json::from_str::<serde_json::Value>(&event).unwrap());
                    Box::pin(async {})
                }
            }),
        };
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(ObservedRequest {
            request_id: 1,
            head: false,
        })
        .unwrap();
        tx.send(ObservedRequest {
            request_id: 2,
            head: false,
        })
        .unwrap();
        drop(tx);
        // A body that looks like an HTTP refusal is content, never metadata.
        let first_body = "HTTP/1.1 403 Forbidden\r\nx-broker-code: wrong\r\n\r\n";
        let wire = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nSet-Cookie: private\r\n\r\n{}HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 403 Forbidden\r\nX-Broker-Code: team_credential_usage_limit\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nno!\r\n0\r\nx-trailer: keep\r\n\r\n", first_body.len(), first_body);
        let mut output = Vec::new();
        forward_responses(&mut wire.as_bytes(), &mut output, rx, &observation, 7)
            .await
            .unwrap();
        assert_eq!(output, wire.as_bytes());
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                serde_json::json!({"kind":"response", "connectionId":"7", "requestId":"1", "status":200, "headers":{}}),
                serde_json::json!({"kind":"response", "connectionId":"7", "requestId":"2", "status":403, "headers":{"x-broker-code":"team_credential_usage_limit"}}),
            ]
        );
    }

    #[tokio::test]
    async fn preserves_truncated_chunk_delimiters_and_stops_observing_oversized_metadata() {
        for (wire, expected_events) in [
            (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r".to_vec(),
                1,
            ),
            (
                format!(
                    "HTTP/1.1 200 OK\r\nx-long: {}\r\n\r\nbody",
                    "x".repeat(MAX_MACHINE_HTTP_HEAD_BYTES)
                )
                .into_bytes(),
                0,
            ),
            (
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nx-long: {}\r\n\r\n",
                    "x".repeat(MAX_MACHINE_HTTP_HEAD_BYTES - 64)
                )
                .into_bytes(),
                1,
            ),
        ] {
            let (tx, rx) = mpsc::unbounded_channel();
            tx.send(ObservedRequest {
                request_id: 1,
                head: false,
            })
            .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let observation = MachineHttpObservation {
                header_names: Vec::new(),
                observer: Arc::new({
                    let events = events.clone();
                    move |event| {
                        events.lock().unwrap().push(event);
                        Box::pin(async {})
                    }
                }),
            };
            let mut output = Vec::new();
            forward_responses(&mut wire.as_slice(), &mut output, rx, &observation, 1)
                .await
                .unwrap();
            assert_eq!(output, wire);
            assert_eq!(events.lock().unwrap().len(), expected_events);
        }
    }

    #[tokio::test]
    async fn pairs_head_and_no_body_responses_before_forwarding_upgrade_bytes() {
        let (tx, rx) = mpsc::unbounded_channel();
        for (request_id, head) in [(1, true), (2, false), (3, false)] {
            tx.send(ObservedRequest { request_id, head }).unwrap();
        }
        let observation = MachineHttpObservation {
            header_names: Vec::new(),
            observer: Arc::new(|_| Box::pin(async {})),
        };
        let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nHTTP/1.1 304 Not Modified\r\nContent-Length: 100\r\n\r\nHTTP/1.1 101 Switching Protocols\r\n\r\n\x00opaque\xff";
        let mut output = Vec::new();
        forward_responses(&mut wire.as_slice(), &mut output, rx, &observation, 1)
            .await
            .unwrap();
        assert_eq!(output, wire);
    }
}
