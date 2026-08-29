#[cfg(test)]
mod tests {
    use crate::{read_preamble, write_preamble, IrohError};
    use std::io::Cursor;
    #[test]
    fn round_trip_and_reject_invalid() {
        let mut out = Vec::new();
        write_preamble(&mut out).unwrap();
        assert_eq!(out, [1]);
        assert!(read_preamble(&mut Cursor::new(out)).is_ok());
        assert_eq!(
            read_preamble(&mut Cursor::new(vec![0])),
            Err(IrohError::InvalidPreamble)
        );
        assert_eq!(
            read_preamble(&mut Cursor::new(Vec::<u8>::new())),
            Err(IrohError::InvalidPreamble)
        );
    }
}
