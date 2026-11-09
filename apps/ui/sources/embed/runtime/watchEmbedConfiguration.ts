import { ApiTokenEmbedConfigChangedV1Schema, type EmbedConfigV1 } from '@happier-dev/protocol/embed';
import { admitEmbedCredential } from '@/embed/credential/admitEmbedCredential';
import { apiSocket } from '@/sync/api/session/apiSocket';
import type { ServerFetch } from '@/sync/http/client';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Reconcile presentation through Self; pushes never carry or replace grant authority. */
export function watchEmbedConfiguration(input: Readonly<{
    request: ServerFetch;
    parentOrigin: string;
    ancestorOrigins: readonly string[];
    isCurrent: () => boolean;
    onConfiguration: (config: EmbedConfigV1 | null) => void;
}>): () => void {
    let disposed = false;
    let pending = false;
    let changed = false;
    const current = () => !disposed && input.isCurrent();
    const refresh = () => {
        if (!current()) return;
        changed = true;
        if (pending) return;
        pending = true;
        fireAndForget((async () => {
            try {
                do {
                    changed = false;
                    const self = await admitEmbedCredential(input);
                    if (current()) input.onConfiguration(self.embedConfig);
                } while (changed && current());
            } finally { pending = false; }
        })(), { tag: 'embed.configuration.refresh' });
    };
    const detachPush = apiSocket.onMessage('ephemeral', value => {
        if (ApiTokenEmbedConfigChangedV1Schema.safeParse(value).success) refresh();
    });
    // The server sends the same wake after room admission on initial connect
    // and reconnect, so this does not need another connection listener or read.
    return () => { disposed = true; detachPush(); };
}
