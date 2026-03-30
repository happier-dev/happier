use std::io::{self, BufRead};

pub enum ReadJsonLine {
    Eof,
    Line(String),
    LimitExceeded,
}

pub fn read_json_line<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<ReadJsonLine> {
    buffer.clear();

    let read_len = reader.read_until(b'\n', buffer)?;
    if read_len == 0 {
        return Ok(ReadJsonLine::Eof);
    }
    if buffer.len() > max_bytes {
        return Ok(ReadJsonLine::LimitExceeded);
    }

    while matches!(buffer.last(), Some(b'\n' | b'\r')) {
        buffer.pop();
    }

    Ok(ReadJsonLine::Line(
        String::from_utf8_lossy(buffer).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{read_json_line, ReadJsonLine};
    use std::io::Cursor;

    #[test]
    fn trims_newlines_from_json_lines() {
        let mut reader = Cursor::new(b"{\"ok\":true}\n".to_vec());
        let mut buffer = Vec::new();

        let line = read_json_line(&mut reader, &mut buffer, 1024).expect("line should read");

        match line {
            ReadJsonLine::Line(text) => assert_eq!(text, "{\"ok\":true}"),
            _ => panic!("expected a line"),
        }
    }

    #[test]
    fn rejects_lines_over_the_output_limit() {
        let mut reader = Cursor::new(vec![b'a'; 17]);
        let mut buffer = Vec::new();

        let line = read_json_line(&mut reader, &mut buffer, 16).expect("line should read");

        assert!(matches!(line, ReadJsonLine::LimitExceeded));
    }
}
