import { ScmHostingPullRequestLifecycleV1ProtocolSchema as lifecycle,
    ScmHostingPullRequestLifecycleActionV1ProtocolSchema as action } from '@happier-dev/protocol/scm/pullRequestLifecycleV1';
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** Composable projections alias the SCM owner's executable parsers. */
export const ScmHostingPullRequestLifecycleV1ProtocolSchema: ProtocolComposableSchema<ReturnType<typeof lifecycle.parse>> = lifecycle;
export const ScmHostingPullRequestLifecycleActionV1ProtocolSchema: ProtocolComposableSchema<ReturnType<typeof action.parse>> = action;
