#[cfg(test)]
mod tests {
    use crate::{copy_bidirectional, CancellationToken, CopyLimits};
    use std::io::Cursor;
    #[test]
    fn preserves_moving_bytes() {
        let payload = b"HTTP/1.1 200 OK\r\n\r\nhello websocket";
        let mut input = Cursor::new(payload.to_vec());
        let mut output = Cursor::new(Vec::new());
        let stats = copy_bidirectional(
            &mut input,
            &mut output,
            &CancellationToken::new(),
            CopyLimits::default(),
        )
        .unwrap();
        assert_eq!(stats.left_to_right.bytes, payload.len() as u64);
        assert_eq!(output.into_inner(), payload);
    }
    #[test]
    fn cancellation_is_observed_before_copy() {
        let mut input = Cursor::new(vec![1]);
        let mut output = Cursor::new(Vec::new());
        let token = CancellationToken::new();
        token.cancel();
        assert!(
            copy_bidirectional(&mut input, &mut output, &token, CopyLimits::default()).is_err()
        );
    }

    #[test]
    fn copies_both_directions_until_eof() {
        struct OneWay {
            input: Cursor<Vec<u8>>,
            output: Vec<u8>,
        }
        impl std::io::Read for OneWay {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.input.read(buf)
            }
        }
        impl std::io::Write for OneWay {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.output.extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut left = OneWay {
            input: Cursor::new(b"left".to_vec()),
            output: Vec::new(),
        };
        let mut right = OneWay {
            input: Cursor::new(b"right".to_vec()),
            output: Vec::new(),
        };
        let stats = copy_bidirectional(
            &mut left,
            &mut right,
            &CancellationToken::new(),
            CopyLimits::default(),
        )
        .unwrap();
        assert_eq!(stats.left_to_right.bytes, 4);
        assert_eq!(stats.right_to_left.bytes, 5);
    }
}
