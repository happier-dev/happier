import {
    redactBugReportSensitiveText as canonicalRedactBugReportSensitiveText,
    trimBugReportTextToMaxBytes as canonicalTrimBugReportTextToMaxBytes,
} from '@happier-dev/protocol/bugs/reports';

import type { PluginRemediationData } from './availability.js';
import type { JsonValue } from './identity.js';

export type { PluginRemediationData } from './availability.js';

export type PluginDiagnosticData = Readonly<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message?: string;
    details?: JsonValue;
    remediation?: PluginRemediationData;
}>;

export type PluginDiagnosticSeverity = PluginDiagnosticData['severity'];

/** The Protocol redactor remains the sole runtime behavior owner. */
export const redactBugReportSensitiveText: (input: string) => string = canonicalRedactBugReportSensitiveText;

/** The Protocol UTF-8 truncator remains the sole runtime behavior owner. */
export const trimBugReportTextToMaxBytes: (input: string, maxBytes: number) => string =
    canonicalTrimBugReportTextToMaxBytes;
