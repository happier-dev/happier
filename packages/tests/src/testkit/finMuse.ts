import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MUSE_MSP_PLAYBACK_SCRIPT, readMuseLoginRecording } from '../../../plugins/muse/src/agent/testkit/mspProcess';

/** FIN substitutes only the native executable. Catalog and Session launches both
 * filter parent environment keys, so playback inputs belong inside the child. */
export async function writeFinMuseExecutable(params: Readonly<{
    binDir: string;
    auditPath: string;
    /** Concurrent reviewer processes must not overwrite each other's boundary evidence. */
    perProcessAudit?: boolean;
    /** Re-read on each native launch so Review and Check may return different output. */
    recordingPath?: string;
}>): Promise<string> {
    await mkdir(params.binDir, { recursive: true });
    const recordingPath = params.recordingPath ?? join(params.binDir, 'muse-playback.json');
    if (!params.recordingPath) await writeFile(recordingPath, JSON.stringify(await readMuseLoginRecording()));
    const advanced: unknown = JSON.parse(await readFile(new URL('../../../plugins/muse/src/agent/testkit/fixtures/advanced.json', import.meta.url), 'utf8'));
    if (!advanced || typeof advanced !== 'object' || !('rows' in advanced) || !Array.isArray(advanced.rows)) {
        throw new Error('FIN native configuration capture lacks wire rows');
    }
    // Same captured accepted transactions used by Muse's runtime.configuration test.
    const controlRows = [...advanced.rows.slice(123, 126), ...advanced.rows.slice(113, 116)];
    const executablePath = join(params.binDir, 'muse');
    await writeFile(executablePath, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('muse 1.4.14'); } else {
const capture = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(recordingPath)}, 'utf8'));
const nativeSessionId = capture.rows.find(row => row.message?.result?.session?.sessionId)?.message.result.session.sessionId;
if (!nativeSessionId) throw new Error('FIN native capture lacks its opened Session');
for (const row of ${JSON.stringify(controlRows)}) {
    const message = row.message;
    const params = message?.params;
    if (params?.sessionId) params.sessionId = nativeSessionId;
    if (message?.method === 'session/setModel') params.model = { providerId: 'meta', modelId: 'muse-spark-1.3-contributor' };
    if (message?.method === 'session/modelChanged') params.modelId = 'muse-spark-1.3-contributor';
    if (message?.method === 'session/setReasoningEffort' || message?.method === 'session/reasoningEffortChanged') params.reasoningEffort = 'minimal';
    capture.rows.push(row);
}
for (const row of capture.rows) {
    const models = row.message?.result?.models;
    if (!Array.isArray(models)) continue;
    const base = models.find(model => model.providerId === 'meta' && model.modelId === 'muse-spark-1.3');
    if (!base || !base.variants?.includes('minimal')) throw new Error('FIN native capture lacks Spark 1.3 with Minimal reasoning');
    // Schema-derived catalogue variation; retain all captured model capabilities.
    models.push({ ...base, modelId: 'muse-spark-1.3-contributor', displayLabel: 'Muse Spark 1.3 contributor', isDefault: false });
}
delete process.env.MUSE_TEST_RECORDING_PATH;
process.env.MUSE_TEST_RECORDING = JSON.stringify(capture);
process.env.MUSE_TEST_AUDIT_PATH = ${JSON.stringify(params.auditPath)}${params.perProcessAudit ? " + '.' + process.pid" : ''};
process.env.MUSE_TEST_SCHEMA = '{}';
${MUSE_MSP_PLAYBACK_SCRIPT}
}
`, { mode: 0o755 });
    return executablePath;
}
