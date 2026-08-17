const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBytesBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const combined = (a << 16) | (b << 8) | c;
    output += BASE64[(combined >>> 18) & 63];
    output += BASE64[(combined >>> 12) & 63];
    output += index + 1 < bytes.length ? BASE64[(combined >>> 6) & 63] : '=';
    output += index + 2 < bytes.length ? BASE64[combined & 63] : '=';
  }
  return output;
}

function decodeBytesBase64(value: string): Uint8Array {
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) {
    throw Object.assign(new Error('invalid_pcm_base64'), { code: 'invalid_pcm_base64' });
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((normalized.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const values = [0, 1, 2, 3].map((delta) => {
      const character = normalized[index + delta]!;
      return character === '=' ? 0 : BASE64.indexOf(character);
    });
    if (values.some((entry) => entry < 0)) throw Object.assign(new Error('invalid_pcm_base64'), { code: 'invalid_pcm_base64' });
    const combined = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    if (offset < bytes.length) bytes[offset++] = (combined >>> 16) & 255;
    if (offset < bytes.length) bytes[offset++] = (combined >>> 8) & 255;
    if (offset < bytes.length) bytes[offset++] = combined & 255;
  }
  return bytes;
}

export function encodePcm16LeBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, samples[index]!, true);
  return encodeBytesBase64(bytes);
}

export function decodePcm16LeBase64(value: string): Int16Array {
  const bytes = decodeBytesBase64(value);
  if (bytes.byteLength % 2 !== 0) throw Object.assign(new Error('invalid_pcm16_length'), { code: 'invalid_pcm16_length' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true);
  return samples;
}
