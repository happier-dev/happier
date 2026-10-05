import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: [
    { find: /^@happier-dev\/protocol\/rpc$/, replacement: fileURLToPath(new URL('../protocol/src/rpc/index.ts', import.meta.url)) },
    { find: /^@happier-dev\/protocol\/rpcErrors$/, replacement: fileURLToPath(new URL('../protocol/src/rpc/errors.ts', import.meta.url)) },
    { find: /^@happier-dev\/protocol\/updates$/, replacement: fileURLToPath(new URL('../protocol/src/updates/index.ts', import.meta.url)) },
    { find: /^@happier-dev\/protocol\/socketRpc$/, replacement: fileURLToPath(new URL('../protocol/src/rpc/socket.ts', import.meta.url)) },
    { find: /^@happier-dev\/protocol$/, replacement: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)) },
    { find: /^@happier-dev\/connection-supervisor$/, replacement: fileURLToPath(new URL('../connection-supervisor/src/index.ts', import.meta.url)) },
  ] },
  test: { ...resolveVitestWorkers(), include: ['src/**/*.test.ts'] },
});
