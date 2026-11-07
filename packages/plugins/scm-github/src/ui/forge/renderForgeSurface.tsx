import * as React from 'react';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { GithubReleasesPage } from '../releases/ReleasesPage.js';
import { useReleaseSessionHelpV1 } from '../releases/useReleaseSessionHelp.js';
import { GithubActionsPage } from './actions/ActionsPage.js';
import { GithubResourceRunPage } from './ResourceRunPage.js';
import { GithubSessionCiPanel } from './session/SessionCiPanel.js';
import { GithubProjectStatusWidget } from './overview/ProjectStatusWidget.js';
import { GithubDeploymentReviewPage } from './deployments/DeploymentReviewPage.js';
import { GITHUB_ACTIONS_PAGE_ID_V1, GITHUB_DEPLOYMENT_REVIEW_VIEW_ID_V1, GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1, GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1, GITHUB_RELEASES_PAGE_ID_V1, GITHUB_RESOURCE_RUN_PAGE_ID_V1, GITHUB_RESOURCE_RUN_SESSION_VIEW_ID_V1, GITHUB_SESSION_CI_VIEW_ID_V1, GITHUB_PROJECT_STATUS_WIDGET_ID_V1 } from './surfaceIds.js';
import { GithubLocalActRunPage } from '../actions/local/LocalActRunPage.js';
import { activate as activateCi } from '../../actions/mounted.js';
import { activateReleaseClientActionsV1 } from '../releases/mountedActions.js';
import { activateDeploymentMonitoringClientActionsV1 } from '../actions/deploymentMonitoring.js';

/** One client artifact for CI and Releases; visual composition remains UI-lane owned. */
export function activate(api: PluginClientApi): void {
    activateCi(api);
    activateReleaseClientActionsV1(api);
    activateDeploymentMonitoringClientActionsV1(api);
}

/** Each forge page this artifact renders, by its declared view id. */
const GITHUB_FORGE_PAGES_V1: Readonly<Record<string, (context: RenderContext) => React.ReactElement>> = {
    [GITHUB_ACTIONS_PAGE_ID_V1]: context => <GithubActionsPage context={context} />,
    [GITHUB_RESOURCE_RUN_PAGE_ID_V1]: context => <GithubResourceRunPage context={context} />,
    [GITHUB_RESOURCE_RUN_SESSION_VIEW_ID_V1]: context => <GithubResourceRunPage context={context} />,
    [GITHUB_RELEASES_PAGE_ID_V1]: context => <GithubReleasesWithSessionHelp context={context} />,
    [GITHUB_DEPLOYMENT_REVIEW_VIEW_ID_V1]: context => <GithubDeploymentReviewPage context={context} />,
    [GITHUB_SESSION_CI_VIEW_ID_V1]: context => <GithubSessionCiPanel context={context} />,
    [GITHUB_PROJECT_STATUS_WIDGET_ID_V1]: context => <GithubProjectStatusWidget context={context} />,
    [GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1]: context => <GithubLocalActRunPage context={context} />,
    [GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1]: context => <GithubLocalActRunPage context={context} />,
};

function GithubReleasesWithSessionHelp({ context }: Readonly<{ context: RenderContext }>): React.ReactElement {
    const sessionHelp = useReleaseSessionHelpV1(context);
    return <GithubReleasesPage context={context} sessionHelp={sessionHelp} />;
}

function GithubForgeSurface(context: RenderContext): React.ReactElement | null {
    const mount = context.surface.mount;
    const viewId = mount.kind === 'destination' ? mount.destination.localId
        : mount.role === 'widget' ? GITHUB_PROJECT_STATUS_WIDGET_ID_V1 : undefined;
    const page = viewId === undefined ? undefined : GITHUB_FORGE_PAGES_V1[viewId];
    return page ? page(context) : null;
}

/** The manifest's `github-forge` renderer names this exact export. */
export const renderSurface = defineUiSurface(GithubForgeSurface);
