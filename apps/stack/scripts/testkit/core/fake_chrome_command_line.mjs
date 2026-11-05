import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// Real CDP transport at the external Chromium boundary; the worker's launch,
// executable adaptation and cleanup remain real.
export async function fakeChromeCommandLine(t, executable = process.execPath, onCommand = () => true) {
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once('data', bytes => {
      const length = bytes[1] & 127;
      const mask = bytes.subarray(2, 6);
      const payload = Buffer.from(bytes.subarray(6, 6 + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      const command = JSON.parse(payload.toString());
      assert.equal(command.method, 'Browser.getBrowserCommandLine');
      socket.once('data', () => socket.end(Buffer.from([0x88, 0])));
      if (!onCommand()) return;
      const response = Buffer.from(JSON.stringify({ id: command.id, result: { arguments: [executable] } }));
      const header = response.length < 126 ? Buffer.from([0x81, response.length]) : Buffer.from([0x81, 126, response.length >> 8, response.length & 255]);
      socket.write(Buffer.concat([header, response]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}
