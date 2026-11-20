// Modal 0.11.0 SDK boundary fixture; the actual worker, roles and native client run.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const statePath = process.env.PROVIDER_CONFORMANCE_STATE;
const read = () => JSON.parse(readFileSync(statePath, 'utf8'));
const write = value => writeFileSync(statePath, JSON.stringify(value));
function available() {
    const failure = read().failure;
    // A rejected token: modal-js surfaces gRPC UNAUTHENTICATED (status 16) as a nice-grpc ClientError.
    if (failure === 'credential') throw Object.assign(new Error('/modal.client.ModalClient/ClientHello UNAUTHENTICATED: Invalid token'),
        { name: 'ClientError', '@@nice-grpc:ClientError': true, code: 16, details: 'Invalid token' });
    if (failure) throw new Error(process.env.MODAL_TOKEN_SECRET);
}
const sandbox = (sandboxId = 'sb-conformance') => ({
    sandboxId,
    async poll() { available(); return read()[sandboxId === 'sb-foreign' ? 'foreignPresent' : 'present'] ? null : 0; },
    async terminate() { available(); write({ ...read(), [sandboxId === 'sb-foreign' ? 'foreignPresent' : 'present']: false }); },
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
});
export class ModalClient {
    constructor() {
        this.profile = { serverUrl: process.env.MODAL_SERVER_URL, tokenId: process.env.MODAL_TOKEN_ID, tokenSecret: process.env.MODAL_TOKEN_SECRET };
        this.apps = { async fromName() { available(); return { appId: 'ap-conformance' }; } };
        this.images = { fromRegistry() { available(); return { imageId: 'im-conformance' }; } };
        this.sandboxes = {
            async create(_app, _image, input) { available(); write({ ...read(), present: true, tags: input?.tags ?? {}, allocations: read().allocations + 1 }); return sandbox(); },
            async fromId(id) { available(); if (!['sb-conformance', 'sb-foreign'].includes(id)) throw new Error(`Unknown sandbox: ${id}`); return sandbox(id); },
            async *list(input) {
                available();
                if (input?.appId && input.appId !== 'ap-conformance') return;
                const matches = tags => Object.entries(input?.tags ?? {}).every(([key, value]) => tags[key] === value);
                if (read().present && matches(read().tags ?? {})) yield sandbox();
                if (read().foreignPresent && matches({ 'happier.managed-id': 'foreign-managed-id' })) yield sandbox('sb-foreign');
            },
        };
    }
    version() { return '0.11.0'; }
    environmentName() { return process.env.MODAL_ENVIRONMENT ?? ''; }
    close() {}
}
