import { redactBugReportSensitiveText as canonicalRedactBugReportSensitiveText, trimBugReportTextToMaxBytes as canonicalTrimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { projectPluginFailureText as canonicalProjectPluginFailureText } from '@happier-dev/protocol/plugins/failureProjection';

import type { PluginDiagnosticData } from '@happier-dev/cli-common/plugins/errors';
export type { PluginDiagnosticData, PluginRemediationData } from '@happier-dev/cli-common/plugins/errors';

export type PluginDiagnosticSeverity = PluginDiagnosticData['severity'];

/** The Protocol redactor remains the sole runtime behavior owner. */
export const redactBugReportSensitiveText: (input: string) => string = canonicalRedactBugReportSensitiveText;

/** The canonical plugin failure projection strips credentials and local paths. */
export const projectPluginFailureText: (error: unknown) => string = canonicalProjectPluginFailureText;

/** The Protocol UTF-8 truncator remains the sole runtime behavior owner. */
export const trimBugReportTextToMaxBytes: (input: string, maxBytes: number) => string =
    canonicalTrimBugReportTextToMaxBytes;
