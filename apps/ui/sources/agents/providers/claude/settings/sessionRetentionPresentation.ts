import {
    ClaudeSessionRetentionReportV1Schema,
    type ClaudeSessionRetentionPolicyV1,
    type ClaudeSessionRetentionReportV1,
} from '@happier-dev/protocol';

export type RetentionPolicy = ClaudeSessionRetentionPolicyV1 | null;
export type RetentionMachineFacts = Readonly<{
    pid: unknown;
    startedAt: unknown;
    cliVersion: unknown;
    source: unknown;
    report: unknown;
}>;
export type RetentionMachineStatus = 'applied' | 'unmanagedStatus' | 'pending' | 'unknown' | 'error' | 'managed';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>> : null;
}

export function sameRetentionPolicy(left: RetentionPolicy, right: RetentionPolicy): boolean {
    return left === null || right === null ? left === right
        : left.mode === right.mode && (left.mode !== 'days' || right.mode === 'days' && left.days === right.days);
}

function hasCurrentRetentionReportSource(facts: RetentionMachineFacts): boolean {
    const source = record(facts.source);
    if (!source || typeof facts.pid !== 'number' || !Number.isFinite(facts.pid)
        || typeof facts.startedAt !== 'number' || !Number.isFinite(facts.startedAt)
        || typeof facts.cliVersion !== 'string' || !facts.cliVersion
        || source.pid !== facts.pid || source.startedAt !== facts.startedAt || source.cliVersion !== facts.cliVersion) return false;
    return true;
}

export function readRetentionMachineReport(facts: RetentionMachineFacts): ClaudeSessionRetentionReportV1 | null {
    if (!hasCurrentRetentionReportSource(facts)) return null;
    const parsed = ClaudeSessionRetentionReportV1Schema.safeParse(facts.report);
    return parsed.success ? parsed.data : null;
}

export function retentionMachineStatus(facts: RetentionMachineFacts, selected: RetentionPolicy): RetentionMachineStatus {
    const report = readRetentionMachineReport(facts);
    if (!report) return hasCurrentRetentionReportSource(facts) && record(facts.report)?.status === 'error' ? 'error' : 'unknown';
    if (!sameRetentionPolicy(report.policy, selected)) return 'pending';
    if (report.targets.some(target => target.status === 'error')) return 'error';
    if (report.targets.some(target => target.status === 'managed')) return 'managed';
    if (report.targets.length === 0) return 'unknown';
    return selected === null ? 'unmanagedStatus' : 'applied';
}

export function retentionChangeNeedsConfirmation(next: RetentionPolicy, current: RetentionPolicy, machines: readonly RetentionMachineFacts[]): boolean {
    if (next === null || sameRetentionPolicy(next, current)) return false;
    // Removing the configured value leaves Claude's current default or an override in charge.
    if (next.mode === 'providerDefault' || machines.length === 0) return true;
    return machines.some(facts => {
        const report = readRetentionMachineReport(facts);
        return !report || report.targets.length === 0 || report.targets.some(target => (
            target.status === 'error' || target.status === 'managed'
            || target.currentDays === null || target.currentDays > next.days
        ));
    });
}
