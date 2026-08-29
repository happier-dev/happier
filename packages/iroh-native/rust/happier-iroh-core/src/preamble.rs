use crate::{validate_preamble, IrohError, Result, TUNNEL_PREAMBLE};
use std::io::{Read, Write};

pub fn write_preamble<W: Write>(writer: &mut W) -> Result<()> {
    writer
        .write_all(&[TUNNEL_PREAMBLE])
        .map_err(IrohError::from)
}
pub fn read_preamble<R: Read>(reader: &mut R) -> Result<()> {
    let mut byte = [0u8; 1];
    let n = reader.read(&mut byte).map_err(IrohError::from)?;
    if n != 1 {
        return Err(IrohError::InvalidPreamble);
    }
    validate_preamble(byte[0])
}
