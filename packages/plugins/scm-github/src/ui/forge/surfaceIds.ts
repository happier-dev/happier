import { GITHUB_DEPLOYMENT_REVIEW_PAGE_ID } from '../../actions/deploymentReviewProtocol.js';

/** The one CI/Releases client artifact and the renderer that mounts its pages. */
export const GITHUB_FORGE_ARTIFACT_ID_V1 = 'github-forge-native';
export const GITHUB_FORGE_RENDERER_ID_V1 = 'github-forge-renderer';
/** Project page: Actions runs and workflows for the Project's repository. */
export const GITHUB_ACTIONS_PAGE_ID_V1 = 'actions';
/** Exact GitHub run URLs opened outside a Project, or in a Session's details. */
export const GITHUB_RESOURCE_RUN_PAGE_ID_V1 = 'github-resource-run';
export const GITHUB_RESOURCE_RUN_SESSION_VIEW_ID_V1 = 'github-resource-run-session';
/** Project page: releases, drafts and the release editor for the Project's repository. */
export const GITHUB_RELEASES_PAGE_ID_V1 = 'releases';
/** The same local-run form in the current Session or Project details pane. */
export const GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1 = 'github-local-act';
export const GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1 = 'github-local-act-project';
/** App page opened from deployment notices, Inbox and the Actions banner. */
export const GITHUB_DEPLOYMENT_REVIEW_VIEW_ID_V1 = GITHUB_DEPLOYMENT_REVIEW_PAGE_ID;
/** Session rail tab: CI for the Session's exact pushed HEAD and branch (lab a6). */
export const GITHUB_SESSION_CI_VIEW_ID_V1 = 'session-ci';
/** Project Overview widget: CI on the default branch and the latest release (lab a7). */
export const GITHUB_PROJECT_STATUS_WIDGET_ID_V1 = 'github-project-status';
