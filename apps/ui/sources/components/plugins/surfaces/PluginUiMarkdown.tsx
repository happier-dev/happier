import * as React from 'react';
import type { HappierMarkdownRenderInput } from '@happier-dev/plugin-ui/presentation';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type PluginMarkdownWorkspace = Readonly<{ target: SurfaceContext['target']; serverId: string }>;

function MarkdownContent({ input, scope }: Readonly<{ input: HappierMarkdownRenderInput; scope?: WorkspaceScopeBase | null }>) {
    return <MarkdownView markdown={input.value} selectable={input.selectable} testID={input.testID}
        inlineReferences={input.inlineReferences} images={input.images} imageScope={scope ?? undefined} profile="document" />;
}

function SessionMarkdown({ input, sessionId, serverId }: Readonly<{ input: HappierMarkdownRenderInput; sessionId: string; serverId: string }>) {
    const scope = useWorkspaceScopeForSession(sessionId, serverId);
    return <MarkdownContent input={input} scope={scope} />;
}

/** Resolve only the host-admitted target, and subscribe only while a plugin actually renders images. */
export function PluginUiMarkdown({ input, workspace }: Readonly<{ input: HappierMarkdownRenderInput; workspace?: PluginMarkdownWorkspace }>) {
    if (input.images && workspace?.target.kind === 'session') {
        return <SessionMarkdown input={input} sessionId={workspace.target.sessionId} serverId={workspace.serverId} />;
    }
    if (input.images && workspace?.target.kind === 'project' && workspace.target.checkout) {
        return <MarkdownContent input={input} scope={workspace.target.checkout} />;
    }
    return <MarkdownContent input={input} />;
}
