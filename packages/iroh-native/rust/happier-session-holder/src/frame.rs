//! Holder wire frames: `[kind u8][len u32 BE][payload]`.
//!
//! Holder -> client
//! - `H` hello (JSON): `{"protocol":1,"holderPid","agentPid","replayFrom","meta"}`; replayed frames follow.
//!   `meta` is the last value a client stored with the `meta` op (null until then).
//! - `o` / `e` Agent stdout / stderr: `[seq u64 BE][bytes]`.
//! - `x` Agent exit: `[seq u64 BE]` + JSON `{"code":int|null,"signal":int|null}`.
//! - `r` operation reply (JSON, never sequenced or replayed): `{"id",...}`.
//!
//! Client -> holder
//! - `i` stdin bytes; `c` close stdin.
//! - `a` acknowledge: `[seq u64 BE]`, cumulative. The client sends it only after the
//!   output up to `seq` is handed to the Session's own outbox; the holder then drops it.
//! - `q` operation request (JSON `{"id","op",...}`). The op set is open: an unknown op
//!   gets `{"id","ok":false,"error":"unknown_op"}`, so later ops (workspace) add no channel.
//!   Ops: `signal {signal}`, `status`, `meta {value}` (stores opaque client JSON, replacing the
//!   previous value, and returns it in every later hello; the holder never interprets it).

use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;

pub fn encode(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub fn encode_sequenced(kind: u8, seq: u64, data: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + data.len());
    payload.extend_from_slice(&seq.to_be_bytes());
    payload.extend_from_slice(data);
    encode(kind, &payload)
}

/// Reads one frame; `Ok(None)` at a clean end of stream.
pub fn read_frame<R: Read + ?Sized>(reader: &mut R) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 5];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    Ok(Some((header[0], payload)))
}

pub fn write_frame<W: Write + ?Sized>(writer: &mut W, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequenced_frames_round_trip() {
        let frame = encode_sequenced(b'o', 7, b"hello");
        let (kind, payload) = read_frame(&mut frame.as_slice()).unwrap().unwrap();
        assert_eq!(kind, b'o');
        assert_eq!(u64::from_be_bytes(payload[..8].try_into().unwrap()), 7);
        assert_eq!(&payload[8..], b"hello");
    }

    #[test]
    fn clean_end_of_stream_is_none_and_truncated_frame_is_an_error() {
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
        let truncated = [b'o', 0, 0, 0, 4, 1];
        assert!(read_frame(&mut truncated.as_slice()).is_err());
    }
}
