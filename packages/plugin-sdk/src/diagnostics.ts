export {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from '@happier-dev/protocol';

import type { PluginRemediationData } from './availability.js';
import type { JsonValue } from './identity.js';

export type { PluginRemediationData } from './availability.js';

export type PluginDiagnosticSeverity = 'info' | 'warning' | 'error';

export type PluginDiagnosticData = Readonly<{
    code: string;
    severity: PluginDiagnosticSeverity;
    message?: string;
    details?: JsonValue;
    remediation?: PluginRemediationData;
}>;
