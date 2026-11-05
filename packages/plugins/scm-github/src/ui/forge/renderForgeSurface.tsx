import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { GithubLocalActRunPage } from '../actions/local/LocalActRunPage.js';
import { GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1, GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1, GITHUB_PROJECT_STATUS_WIDGET_ID_V1 } from './surfaceIds.js';
const GITHUB_FORGE_PAGES_V1: Readonly<Record<string, (context: RenderContext) => React.ReactElement>> = {
    [GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1]: context => <GithubLocalActRunPage context={context} />,
    [GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1]: context => <GithubLocalActRunPage context={context} />,
};

function GithubForgeSurface(context: RenderContext): React.ReactElement | null {
    const mount = context.surface.mount;
    const viewId = mount.kind === 'destination' ? mount.destination.localId
        : mount.role === 'widget' ? GITHUB_PROJECT_STATUS_WIDGET_ID_V1 : undefined;
    const page = viewId === undefined ? undefined : GITHUB_FORGE_PAGES_V1[viewId];
    return page ? page(context) : null;
}

/** The manifest's `github-forge` renderer names this exact export. */
export const renderSurface = defineUiSurface(GithubForgeSurface);
