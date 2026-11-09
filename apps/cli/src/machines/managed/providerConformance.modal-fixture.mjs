// Modal 0.11.0 SDK boundary fixture; the actual worker, roles and native client run.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const statePath = process.env.PROVIDER_CONFORMANCE_STATE;
const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
const write = value => writeFileSync(statePath, JSON.stringify(value));
function available() { if (read().failure) throw new Error(process.env.MODAL_TOKEN_SECRET); }
const sandbox = {
    sandboxId: 'sb-conformance',
    async poll() { available(); return read().present ? null : 0; },
    async terminate() { available(); write({ ...read(), present: false }); },
    filesystem: { async writeBytes(bytes, path) { available(); writeFileSync(path, bytes); } },
    async exec(argv) {
        available();
        const input = [];
        let completed;
        let resolveOutput;
        const done = new Promise(resolve => { resolveOutput = resolve; });
        const finish = () => {
            if (completed) return;
            completed = spawnSync(argv[0], argv.slice(1), { input: Buffer.concat(input) });
            if (completed.error) throw completed.error;
            resolveOutput();
        };
        const stream = channel => new ReadableStream({ async start(controller) {
            await done;
            controller.enqueue(completed[channel]); controller.close();
        } });
        return {
            stdin: { async writeBytes(bytes) { input.push(bytes); }, async close() {
                finish();
            } },
            stdout: stream('stdout'), stderr: stream('stderr'),
            async wait() { finish(); await done; return completed.status; },
        };
    },
};
export class ModalClient {
    constructor() {
        this.profile = { serverUrl: process.env.MODAL_SERVER_URL, tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET };
        this.apps = { async fromName() { available(); return { appId: 'ap-conformance' }; } };
        this.images = { fromRegistry() { available(); return { imageId: 'im-conformance' }; } };
        this.sandboxes = {
            async create() { available(); write({ ...read(), present: true }); return sandbox; },
            async fromId() { available(); return sandbox; },
            async *list() { available(); if (read().present) yield sandbox; },
        };
    }
    version() { return '0.11.0'; }
    environmentName() { return process.env.MODAL_ENVIRONMENT ?? ''; }
    close() {}
}
