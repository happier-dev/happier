import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import type { TerminalHostHandle } from '@happier-dev/agents';
import { configuration } from '@/configuration';
import { bindHerdrAgentIfNeeded } from '@/integrations/herdr/bindManagedSession';
import { readTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalMetadataFromHostHandle, resolveExistingTerminalHostLifecycle } from '@/terminal/runtime/terminalMetadata';

/** One publication/binding owner for prepared hosts and admitted foreground clients. */
export async function publishNativeAgentTerminalHostBinding(params: Readonly<{
    session: ApiSessionClient;
    handle: TerminalHostHandle;
    agentId: string;
    reportSessionMetadataToDaemon: (input: Readonly<{ sessionId: string; metadata: Metadata }>) => Promise<void>;
    herdrClient?: Parameters<typeof bindHerdrAgentIfNeeded>[0]['client'];
}>): Promise<void> {
    const terminal = buildTerminalMetadataFromHostHandle(params.handle);
    const attachment = await readTerminalHostAttachmentInfo({ happyHomeDir: configuration.happyHomeDir, sessionId: params.session.sessionId });
    const lifecycle = resolveExistingTerminalHostLifecycle({ ...params.session.getMetadataSnapshot(), terminal }, attachment) ?? 'owned';
    let updatedMetadata: Metadata | null = null;
    await params.session.updateMetadata(metadata => {
        updatedMetadata = { ...metadata, terminal };
        return updatedMetadata;
    });
    if (updatedMetadata) await params.reportSessionMetadataToDaemon({ sessionId: params.session.sessionId, metadata: updatedMetadata });
    await bindHerdrAgentIfNeeded({ session: params.session, sessionId: params.session.sessionId,
        agent: params.agentId, terminal, preserveHostOnClose: lifecycle === 'owned',
        ...(params.herdrClient ? { client: params.herdrClient } : {}),
    });
}
