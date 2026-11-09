import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { readSessionRowPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';

/**
 * The Session's identity mark (its Agent) in the Follow panel's header and in the Followers / Following rows (lab P1-P,
 * P2-S). Before its metadata is known the header shows nothing; a row passes `rowGlyph` so its mark column keeps its
 * place with a quiet session glyph instead.
 */
export function FollowSessionMark(props: Readonly<{ session: Session | SessionListRenderableSession | null; serverId: string; rowGlyph?: boolean }>) {
    const { theme } = useUnistyles();
    const agentId = props.session ? readSessionRowPresentationAgentId(props.session) : null;
    const metadata = props.session && 'agentState' in props.session
        ? readSessionOwnerMetadataView(props.session)
        : props.session?.metadata;
    if (!agentId) return props.rowGlyph ? <Icon name="stack" size={18} color={theme.colors.text.secondary} /> : null;
    return <SessionAgentCatalogIdentityIcon agentId={agentId} machineId={resolveSessionMachineId(metadata)}
        serverId={props.serverId} color={theme.colors.text.primary} size={ICON_SIZE.md} />;
}
