import { DEFAULT_BUG_REPORTS_CAPABILITIES, type BugReportsCapabilities } from '@happier-dev/protocol/features/payload/capabilities/bugReportsCapabilities';

export type BugReportsFeature = BugReportsCapabilities & Readonly<{ enabled: boolean }>;

export const DEFAULT_BUG_REPORT_CAPABILITIES: BugReportsCapabilities = DEFAULT_BUG_REPORTS_CAPABILITIES;
