import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { awaitCliActionResult } from '@/session/actions/awaitCliActionResult';
import { invokeAccountMachineSourceAction } from './accountMachineActionTransport';

const serverUrl = process.argv[2];
if (!serverUrl) throw new Error('Missing fixture Home');
const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: 'acme.cancel-read' }));
const sourceCustody = { kind: 'managed', immutableGenerationId: 'cancel-fixture', installSource: 'archive' } as const;
const caller = new AbortController();
const onInterrupt = () => caller.abort();
process.once('SIGINT', onInterrupt);
try {
    const result = await awaitCliActionResult(async () => {
        const execution = await invokeAccountMachineSourceAction({
            credentials: { token: 'cancel-fixture', encryption: null }, serverUrl, machineId: 'cancel-machine',
            callerManifest: manifest, callerSourceCustody: sourceCustody,
            source: { manifest, occurrenceId: 'source-occurrence', sourceCustody },
            request: { action: { pluginId: manifest.id, localId: 'read' }, input: {},
                ...(process.argv[3] === 'observation' ? { readObservation: { accept: () => {}, invalidate: () => {} } } : {}),
                caller: { kind: 'plugin', pluginId: manifest.id, occurrenceId: 'caller-occurrence',
                    contribution: { id: 'read', qualifiedId: `${manifest.id}/actions/read` }, originSurface: 'cli' },
                originSurface: 'cli', signal: caller.signal },
        });
        return execution.status === 'executed' ? { ok: true, result: execution.value }
            : { ok: false, errorCode: execution.code, error: execution.message,
                ...readPluginActionFailureAuthorPayload(execution.data) };
    }, caller.signal);
    console.log(JSON.stringify(result));
    if (process.argv[3] === 'finite' && !result.ok) process.exitCode = 1;
    console.error(JSON.stringify({ resources: process.getActiveResourcesInfo() }));
} finally {
    process.removeListener('SIGINT', onInterrupt);
}
