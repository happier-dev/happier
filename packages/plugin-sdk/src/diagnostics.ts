import { redactBugReportSensitiveText as canonicalRedactBugReportSensitiveText, trimBugReportTextToMaxBytes as canonicalTrimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { projectPluginFailureText as canonicalProjectPluginFailureText } from '@happier-dev/protocol/plugins/failureProjection';

import type { PluginDiagnosticData } from '@happier-dev/cli-common/plugins/errors';
import { isBaseCredentialDiagnosticKey as canonicalIsBaseCredentialDiagnosticKey,
    isUnsafeTelemetryDataKey as canonicalIsUnsafeTelemetryDataKey } from '@happier-dev/protocol/common/sensitiveKeys';
export type { PluginDiagnosticData, PluginRemediationData } from '@happier-dev/cli-common/plugins/errors';

export type PluginDiagnosticSeverity = PluginDiagnosticData['severity'];

/** Canonical key classifiers for secret-free structured diagnostics. */
export const isBaseCredentialDiagnosticKey: (input: string) => boolean = canonicalIsBaseCredentialDiagnosticKey;
export const isUnsafeTelemetryDataKey: (input: string) => boolean = canonicalIsUnsafeTelemetryDataKey;

/** The Protocol redactor remains the sole runtime behavior owner. */
export const redactBugReportSensitiveText: (input: string) => string = canonicalRedactBugReportSensitiveText;

/** The canonical plugin failure projection strips credentials and local paths. */
export const projectPluginFailureText: (error: unknown) => string = canonicalProjectPluginFailureText;

/** The Protocol UTF-8 truncator remains the sole runtime behavior owner. */
export const trimBugReportTextToMaxBytes: (input: string, maxBytes: number) => string =
    canonicalTrimBugReportTextToMaxBytes;
