import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

export type TerminalUtf8StreamDecoder = Readonly<{
  decode: (chunk: Uint8Array | Buffer | string) => string;
  flush: () => string;
}>;

export function toPtyBytes(chunk: Uint8Array | Buffer | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return Buffer.from(chunk);
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, 'utf8');
  }
  return Buffer.from(chunk);
}

export function createUtf8StreamDecoder(): TerminalUtf8StreamDecoder {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return {
    decode: (chunk) => {
      const bytes = toPtyBytes(chunk);
      if (!bytes.length) return '';
      return decoder.decode(bytes, { stream: true });
    },
    flush: () => decoder.decode(),
  };
}
