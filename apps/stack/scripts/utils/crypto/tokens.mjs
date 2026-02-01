import { randomBytes } from 'node:crypto';

export function base64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function randomToken(lenBytes = 24) {
  return base64Url(randomBytes(lenBytes));
}

