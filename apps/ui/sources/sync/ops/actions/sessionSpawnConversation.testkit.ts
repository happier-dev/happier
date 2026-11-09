import { readFile } from 'node:fs/promises';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createFirstConversationAgentFixture } from '../../../../../cli/src/daemon/testkit/firstConversationAgent.testkit';
import { createHiddenCarrierAgentFixture } from '../../../../../cli/src/agent/voice/agent/hiddenCarrier.testkit';

const firstInput = 'packed daemon-child bridge';

/** Substitute only the external Agent. Admission, native Exec, input custody,
 * transcript persistence and completed Turn projection remain production owners. */
export async function createSessionSpawnConversationFixture(input: Readonly<{
    ownAccount: boolean;
    disconnectNativeReplyEvents: boolean;
    disconnectAgentRegistration?: boolean;
    voiceNativeStorePath?: string;
}>) {
    if (input.ownAccount) {
        const fixture = input.voiceNativeStorePath
            ? createHiddenCarrierAgentFixture(firstInput, { nativeStorePath: input.voiceNativeStorePath })
            : createFirstConversationAgentFixture(firstInput);
        if (input.voiceNativeStorePath) return { pluginId: fixture.manifest.id, localId: 'agent', ...fixture, firstInput };
        const assistantEvent = "emit({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant', text });";
        if (fixture.files['agent.mjs'].split(assistantEvent).length !== 2) {
            throw new Error('First-conversation native reply event changed');
        }
        const source = fixture.files['agent.mjs'].replace(assistantEvent, input.disconnectNativeReplyEvents
                ? '/* Native assistant event deliberately disconnected. */'
                : "emit({ kind: 'transcript-message-committed', messageId: `${input.inputIds[0]}:assistant`, turnId: input.delivery.turnId, role: 'assistant', text });");
        return { pluginId: fixture.manifest.id, localId: 'agent', manifest: fixture.manifest,
            files: { ...fixture.files, 'agent.mjs': source,
                ...(input.disconnectAgentRegistration ? {
                    // A valid external module with its one registration removed:
                    // the real activation/read/Action owners must detect it.
                    'daemon.mjs': 'export function activate() {}',
                } : {}) }, firstInput };
    }

    // Preserve the incumbent shared-recipient fixture, which exercises its
    // separate requester credential carrier.
    const root = new URL('../../../../../../packages/tests/fixtures/plugin-platform/agent-runtime-conformance/', import.meta.url);
    const manifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(new URL('.happier-plugin/plugin.json', root), 'utf8')));
    return { pluginId: 'acme.native-runtime-proof', localId: 'novel-native-agent', manifest,
        files: { 'daemon.mjs': await readFile(new URL('daemon.mjs', root), 'utf8'),
            'agent-runtime.mjs': await readFile(new URL('agent-runtime.mjs', root), 'utf8') }, firstInput };
}
