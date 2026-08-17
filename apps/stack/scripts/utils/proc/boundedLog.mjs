import {
  closeSync,
  createWriteStream,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Writable } from 'node:stream';

export const DEFAULT_BOUNDED_LOG_MAX_BYTES = 16 * 1024 * 1024;

export function createBoundedLogWriteStream(filePath, maxBytes = DEFAULT_BOUNDED_LOG_MAX_BYTES) {
  const normalizedMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.trunc(maxBytes)
    : DEFAULT_BOUNDED_LOG_MAX_BYTES;
  const rotatedPath = `${filePath}.1`;
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    size = 0;
  }
  if (size > normalizedMaxBytes) {
    let descriptor = null;
    try {
      const tail = Buffer.allocUnsafe(normalizedMaxBytes);
      descriptor = openSync(filePath, 'r');
      const bytesRead = readSync(
        descriptor,
        tail,
        0,
        normalizedMaxBytes,
        size - normalizedMaxBytes,
      );
      closeSync(descriptor);
      descriptor = null;
      rmSync(rotatedPath, { force: true });
      writeFileSync(rotatedPath, tail.subarray(0, bytesRead));
      writeFileSync(filePath, '');
      size = 0;
    } catch {
      if (descriptor != null) {
        try {
          closeSync(descriptor);
        } catch {
          // The stream error path below remains authoritative.
        }
      }
    }
  }

  let writer = null;
  const openDestination = (flags) => {
    const stream = createWriteStream(filePath, { flags });
    stream.on('error', (error) => {
      if (writer && !writer.destroyed) writer.destroy(error);
    });
    return stream;
  };
  let destination = openDestination('a');

  writer = new Writable({
    write(chunk, _encoding, callback) {
      let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > normalizedMaxBytes) {
        bytes = bytes.subarray(bytes.length - normalizedMaxBytes);
      }

      const writeCurrent = () => {
        size += bytes.length;
        destination.write(bytes, callback);
      };
      if (size + bytes.length <= normalizedMaxBytes) {
        writeCurrent();
        return;
      }

      destination.end(() => {
        try {
          rmSync(rotatedPath, { force: true });
          renameSync(filePath, rotatedPath);
        } catch {
          // Rotation is best-effort. Reopening with `w` still bounds the active file.
        }
        destination = openDestination('w');
        size = 0;
        writeCurrent();
      });
    },
    final(callback) {
      destination.end(callback);
    },
  });
  return writer;
}
