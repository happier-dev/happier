use std::io::{self, BufRead};

pub enum ReadJsonLine {
    Eof,
    Line(String),
}

pub fn read_json_line<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> io::Result<ReadJsonLine> {
    buffer.clear();

    let read_len = reader.read_until(b'\n', buffer)?;
    if read_len == 0 {
        return Ok(ReadJsonLine::Eof);
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

        let line = read_json_line(&mut reader, &mut buffer).expect("line should read");

        match line {
            ReadJsonLine::Line(text) => assert_eq!(text, "{\"ok\":true}"),
            _ => panic!("expected a line"),
        }
    }

    #[test]
    fn reads_a_final_unterminated_line_then_eof() {
        let mut reader = Cursor::new(b"{\"ok\":true}".to_vec());
        let mut buffer = Vec::new();

        let line = read_json_line(&mut reader, &mut buffer).expect("line should read");
        assert!(matches!(line, ReadJsonLine::Line(text) if text == "{\"ok\":true}"));
        assert!(matches!(
            read_json_line(&mut reader, &mut buffer).unwrap(),
            ReadJsonLine::Eof
        ));
    }
}
