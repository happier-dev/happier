export {
    isPluginActionHandlerInvocationNotStartedAdvisory,
    isPluginError,
    PluginError,
    readPluginErrorRequestIdV1,
} from '@happier-dev/cli-common/plugins/errors';
export type {
    PluginActionHandlerInvocation,
    PluginErrorData,
} from '@happier-dev/cli-common/plugins/errors';
// Share the host's content-free exception projection with client Action recovery.
export { readUnexpectedActionErrorDiagnosticV1, ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
