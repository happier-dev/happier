//! A target-local Provider consumer uses the existing workspace byte channel.
//! The listener and every accepted socket are ordinary numbered streams; the
//! host forwards bytes to its already-authorized consumer. No credentials or
//! Provider decisions live here, and no listener binds outside loopback.

use std::sync::Arc;
use serde_json::Value;
use crate::{outbox::Outbox, streams::Streams};

#[cfg(unix)]
pub fn listen(streams: &Arc<Streams>, outbox: &Arc<Outbox>) -> Result<Value, &'static str> {
    use std::net::TcpListener;
    use std::os::fd::AsRawFd;
    use serde_json::json;
    use crate::{streams::{Stream, tagged}, terminal::StopSignal};

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|_| "loopback_listener_unavailable")?;
    let address = listener.local_addr().map_err(|_| "loopback_listener_unavailable")?;
    let stop = StopSignal::new().map_err(|_| "loopback_listener_unavailable")?;
    let stop_read = stop.read;
    let stream = streams.allocate();
    streams.live.lock().unwrap().insert(stream, Stream { pid: None, stdin: None, stop: Some(stop), pty: None });
    let streams = streams.clone();
    let outbox = outbox.clone();
    std::thread::spawn(move || {
        while readable(listener.as_raw_fd(), stop_read) {
            let Ok((socket, _)) = listener.accept() else { break };
            if let Ok(connection) = accept(socket, &streams, &outbox) {
                outbox.send(b'O', &tagged(stream, format!("{}\n", json!({ "stream": connection })).as_bytes()));
            }
        }
        drop(listener);
        streams.live.lock().unwrap().remove(&stream);
        outbox.send(b'X', &tagged(stream, br#"{"code":0,"signal":null}"#));
    });
    Ok(json!({ "stream": stream, "origin": format!("http://{address}") }))
}

#[cfg(not(unix))]
pub fn listen(_streams: &Arc<Streams>, _outbox: &Arc<Outbox>) -> Result<Value, &'static str> {
    Err("loopback_listener_unavailable")
}

#[cfg(unix)]
fn readable(fd: i32, stop: i32) -> bool {
    loop {
        let mut fds = [libc::pollfd { fd, events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: stop, events: libc::POLLIN, revents: 0 }];
        if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } >= 0 {
            return fds[1].revents == 0 && fds[0].revents != 0;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted { return false; }
    }
}

#[cfg(unix)]
fn accept(mut socket: std::net::TcpStream, streams: &Arc<Streams>, outbox: &Arc<Outbox>) -> std::io::Result<u32> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use crate::{streams::{Stream, tagged}, terminal::StopSignal};

    let writer = socket.try_clone()?;
    let stop = StopSignal::new()?;
    let stop_read = stop.read;
    let stream = streams.allocate();
    streams.live.lock().unwrap().insert(stream, Stream {
        pid: None, stdin: Some(Box::new(ToSocket(writer))), stop: Some(stop), pty: None,
    });
    let streams = streams.clone();
    let outbox = outbox.clone();
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        while readable(socket.as_raw_fd(), stop_read) {
            match socket.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => outbox.send(b'O', &tagged(stream, &buffer[..n])),
            }
        }
        let _ = socket.shutdown(std::net::Shutdown::Both);
        streams.live.lock().unwrap().remove(&stream);
        outbox.send(b'X', &tagged(stream, br#"{"code":0,"signal":null}"#));
    });
    Ok(stream)
}

#[cfg(unix)]
struct ToSocket(std::net::TcpStream);

#[cfg(unix)]
impl std::io::Write for ToSocket {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> { self.0.write(bytes) }
    fn flush(&mut self) -> std::io::Result<()> { self.0.flush() }
}

#[cfg(unix)]
impl Drop for ToSocket {
    fn drop(&mut self) { let _ = self.0.shutdown(std::net::Shutdown::Write); }
}
