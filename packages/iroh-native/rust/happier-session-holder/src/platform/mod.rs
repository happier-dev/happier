#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    fn local_path(name: &str) -> String {
        if cfg!(windows) {
            format!(r"\\.\pipe\happier-holder-test-{name}-{}", std::process::id())
        } else {
            std::env::temp_dir().join(format!("hh-{name}-{}.sock", std::process::id())).to_string_lossy().into_owned()
        }
    }

    /// A bound listener is connectable at once, and again while it serves a client, like a
    /// bound Unix socket: the holder prints its readiness line right after binding, and a
    /// reattaching runner connects while the previous client may still be served.
    #[test]
    fn clients_connect_before_each_accept() {
        let path = local_path("bound");
        let listener = super::Listener::bind(&path).unwrap();
        let (_, mut first) = super::connect(&path).expect("connect before the first accept");
        let (mut served, _) = listener.accept().unwrap();
        first.write_all(b"1").unwrap();
        let mut byte = [0u8; 1];
        served.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"1");
        let (_, mut second) = super::connect(&path).expect("connect while the first client is served");
        let (mut served, _) = listener.accept().unwrap();
        second.write_all(b"2").unwrap();
        served.read_exact(&mut byte).unwrap();
        assert_eq!(&byte, b"2");
        listener.remove();
        super::remove_socket_path(&path);
    }
}
