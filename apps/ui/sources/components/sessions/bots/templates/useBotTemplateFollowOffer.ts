import * as React from 'react';
import { BotTemplateArtifactHeaderV1Schema, type BotTemplateInstanceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { readBotTemplateUpdateOfferV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { useArtifactRows } from '@/sync/domains/state/storage';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type BotTemplateFollowOffer = Readonly<{
    offer: ReturnType<typeof readBotTemplateUpdateOfferV1>;
    name: string | null;
    /** The template author's display name, when the Artifact row carries it. */
    author: string | null;
    version: string;
}>;

/** Info follows exact pushed headers; its opening fallback never reads release content or the retained base. */
export function useBotTemplateFollowOffer(instance: BotTemplateInstanceV1): BotTemplateFollowOffer | null {
    const source = instance.source.kind === 'artifact' && instance.follow ? instance.source : null;
    const ids = React.useMemo(() => source ? [source.artifactId] : [], [source?.artifactId]);
    const [row] = useArtifactRows(ids);
    const { binding } = useServerCredentialAccountScopeBinding(source?.serverId);
    const pushed = row?.sourceServerId && source && areServerProfileIdentifiersEquivalent(row.sourceServerId, source.serverId)
        ? BotTemplateArtifactHeaderV1Schema.safeParse(row.rawHeader ?? row.header) : null;
    const header = pushed?.success && pushed.data.state === 'released' ? pushed.data : null;
    const key = JSON.stringify([source, binding?.scope, binding?.revision]);
    const [read, setRead] = React.useState<Readonly<{ key: string; header: Readonly<{ title: string; version: string; author: string | null }> | null }> | null>(null);
    React.useEffect(() => {
        if (!source || header || !binding) return;
        const controller = new AbortController();
        void import('@/sync/ops/actions/botTemplateActionDeps')
            .then(({ readUiBotTemplateReleaseHeader }) => readUiBotTemplateReleaseHeader({ ...source,
                expectedAccountId: binding.scope.accountId }, controller.signal))
            .then(result => { if (!controller.signal.aborted && binding.isCurrent()) setRead({ key, header: result }); },
                () => { if (!controller.signal.aborted && binding.isCurrent()) setRead({ key, header: null }); });
        return () => controller.abort();
    }, [key, Boolean(header), row?.headerVersion, binding]);
    const released = header ? { ...header, author: row?.ownerDisplayName ?? null }
        : binding?.isCurrent() && read?.key === key ? read.header : null;
    return released ? { offer: readBotTemplateUpdateOfferV1(instance, released.version), name: released.title,
        author: released.author, version: released.version } : null;
}
