import { describe, expect, it, vi } from "vitest";
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { UsageNativeAccountingSubjectSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

import { createScopedUsageEvidenceRowNormalizer, isPublicEligibleUsageRow, toScopedUsageEvidenceRow, toScopedUsageEventRow } from "./scopedUsageEventRow";

function row(overrides: Partial<Parameters<typeof toScopedUsageEventRow>[0]> = {}) {
    return {
        id: "event-1",
        sessionId: "session-1",
        observedAt: new Date("2026-09-07T12:00:00.000Z"),
        createdAt: new Date("2026-09-07T12:00:01.000Z"),
        agentId: "claude",
        backendMode: "remote",
        modelId: "claude-sonnet",
        projectKey: null,
        workspaceId: null,
        machineId: "worker-1",
        source: "claude_sdk",
        scope: "turn_delta",
        isCumulative: false,
        turnId: "turn-1",
        requestCount: 0,
        teamCredentialResourceId: null,
        teamCredentialActorAccountId: null,
        teamCredentialExternalApiKeyId: null,
        teamCredentialSourceCredentialId: null,
        brokerMachineId: null,
        credentialDeliveryMode: null,
        inputTokens: 8,
        outputTokens: 4,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 12,
        reportedCostUsd: 0.11,
        estimatedCostUsd: 0,
        invoiceCostUsd: 0,
        billingContext: "api_usage",
        costSource: "provider_reported",
        currency: "USD",
        costBreakdown: JSON.stringify({ input: 0.07, output: 0.04, garbage: "drop" }),
        contextUsedTokens: 12,
        contextWindowTokens: 200_000,
        ...overrides,
    };
}

describe('captured Usage metadata admission', () => {
    it('admits native subjects once per distinct captured value while preserving per-event accounting and attribution', () => {
        // Actual Account A capture: 107,019 rows, 54,945 subject rows, 3,976 subjects.
        const subject = (index: number) => ({ kind: 'native', machineId: 'machine',
            agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
            sourceRootKey: 'root', nativeSessionKey: `native-${index % 3_976}` });
        const value = (index: number) => JSON.stringify({
            usageAccounting: { path: 'native', status: 'available', asOfMs: index, extra: 'drop' },
            ...(index < 54_945 ? { accountingSubject: subject(index) } : {}), measurement: index,
        });
        const normalize = createScopedUsageEvidenceRowNormalizer();
        const subjects = new Set<unknown>();
        let last;
        for (let index = 0; index < 107_019; index++) {
            const admitted = normalize({ id: index, metadata: value(index) });
            if (admitted.accountingEvidence.subject) subjects.add(admitted.accountingEvidence.subject);
            if (index === 107_018) last = admitted;
        }
        expect(subjects.size, 'native identity admission follows distinct subjects, not repeated events').toBe(3_976);
        expect(last).toMatchObject({ id: 107_018, metadata: {
            usageAccounting: { path: 'native', status: 'available', asOfMs: 107_018 }, measurement: 107_018,
        } });
        const first = normalize({ id: 'first', metadata: value(0) });
        const changed = normalize({ id: 'changed', metadata: value(1) });
        expect(changed.metadata).not.toBe(first.metadata);
        expect(createScopedUsageEvidenceRowNormalizer()({ metadata: value(0) }).accountingEvidence.subject)
            .not.toBe(first.accountingEvidence.subject);
        const attribution = (accountScope: 'personal' | 'workspace') => JSON.stringify({
            usageAccounting: { path: 'runtime' }, accountingSubject: subject(0),
            usageAttribution: { v: 1, turnId: 'turn-1', source: { kind: 'native', connectedAccount: null, accountScope } },
        });
        const personal = normalize(row({ metadata: attribution('personal') }));
        const workspace = normalize(row({ metadata: attribution('workspace') }));
        expect(isPublicEligibleUsageRow(toScopedUsageEventRow(personal))).toBe(true);
        expect(isPublicEligibleUsageRow(toScopedUsageEventRow(workspace))).toBe(false);
    });

    it('retains canonical malformed, object-valued and already-admitted evidence semantics', () => {
        const normalize = createScopedUsageEvidenceRowNormalizer();
        const subject = { kind: 'native', machineId: 'machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
            sourceRootKey: 'root', nativeSessionKey: 'native' };
        for (const metadata of [undefined, null, '{malformed', 'null', '[]', '{"usageAccounting":{"path":123}}',
            JSON.stringify({ usageAccounting: { path: 'native', extra: 'drop' }, accountingSubject: subject, opaque: { key: 'value' } }),
            { usageAccounting: { path: 'runtime' }, accountingSubject: { ...subject, machineId: 123 } }]) {
            expect(normalize({ metadata })).toEqual(toScopedUsageEvidenceRow({ metadata }));
            expect(normalize({ metadata })).toEqual(toScopedUsageEvidenceRow({ metadata }));
        }
        const metadata = JSON.stringify({ usageAccounting: { path: 'native' } });
        normalize({ metadata });
        const admitted = { accounting: { path: 'runtime' as const }, subject: null };
        expect(normalize({ metadata, accountingEvidence: admitted }).accountingEvidence).toBe(admitted);
        const mutable = { usageAccounting: { path: 'runtime' as 'runtime' | 'native' } };
        normalize({ metadata: mutable });
        mutable.usageAccounting.path = 'native';
        expect(normalize({ metadata: mutable }).accountingEvidence.accounting?.path).toBe('native');
    });
});

describe('public usage eligibility', () => {
    it.each([
        { agentId: 'opencode', metadata: undefined },
        { agentId: 'pi', scope: 'session_cumulative', isCumulative: true, turnId: null },
        { agentId: 'legacy', sessionId: null, turnId: null },
    ])('counts usage without personal ownership proof ($agentId)', overrides => {
        expect(isPublicEligibleUsageRow(toScopedUsageEventRow(row(overrides)))).toBe(true);
    });

    it('excludes witnessed workspace usage without requiring a matching turn or exact delta', () => {
        expect(isPublicEligibleUsageRow(toScopedUsageEventRow(row({ turnId: null, scope: 'session_cumulative',
            isCumulative: true, metadata: { usageAttribution: { v: 1, turnId: 'request',
                source: { kind: 'native', connectedAccount: null, accountScope: 'workspace' } } },
        })))).toBe(false);
    });

    it.each(['teamCredentialResourceId', 'teamCredentialActorAccountId', 'teamCredentialExternalApiKeyId',
        'teamCredentialSourceCredentialId'] as const)('excludes each Team credential marker (%s)', marker => {
        expect(isPublicEligibleUsageRow(toScopedUsageEventRow(row({ [marker]: 'team-marker', metadata: {
            usageAttribution: { v: 1, turnId: 'turn-1', source: { kind: 'native', connectedAccount: null, accountScope: 'personal' } },
        } })))).toBe(false);
    });
});

describe("toScopedUsageEventRow", () => {
    it('validates native subjects only on rows that carry one', () => {
        const parser = vi.spyOn(createStoredReadSchema(UsageNativeAccountingSubjectSchema), 'safeParse');
        try {
            // Account A's measured 90D switch reads 74,212 events. Missing
            // optional native identity must not construct one parse error per row.
            for (let index = 0; index < 74_212; index++) {
                const mapped = toScopedUsageEventRow(row({ metadata: {
                    usageAccounting: { path: 'runtime', status: 'available' },
                } }));
                expect(mapped.accountingEvidence?.subject).toBeNull();
            }
            expect(parser).toHaveBeenCalledTimes(0);
            const subject = { kind: 'native', machineId: 'machine',
                agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                sourceRootKey: 'root', nativeSessionKey: 'native-session' };
            expect(toScopedUsageEventRow(row({ metadata: { accountingSubject: subject } }))
                .accountingEvidence?.subject).toEqual(subject);
            expect(toScopedUsageEventRow(row({ metadata: { accountingSubject: { ...subject, machineId: 123 } } }))
                .accountingEvidence?.subject).toBeNull();
            expect(parser).toHaveBeenCalledTimes(2);
        } finally {
            parser.mockRestore();
        }
    });
    it("opens stored metadata, preserves internal evidence, and normalizes canonical accounting fields", () => {
        const mapped = toScopedUsageEventRow(row({ metadata: JSON.stringify({ usageAccounting: { inferenceId: "native-inference", path: "native", status: "partial", extra: "drop" }, private: "drop" }) }));
        expect(mapped.metadata).toEqual({ usageAccounting: { inferenceId: "native-inference", path: "native", status: "partial" }, private: "drop" });
        expect(toScopedUsageEventRow(row({ metadata: "{invalid" })).metadata).toBeUndefined();
    });
    it("preserves Team measurement evidence through the shared scoped row projection", () => {
        const metadata = { measurement: "reported", usageAccounting: { path: "runtime", extra: "drop" } };
        expect(toScopedUsageEventRow(row({ metadata })).metadata).toEqual({ measurement: "reported", usageAccounting: { path: "runtime" } });
    });
    it("retains validated native subject evidence without unknown fields or malformed identity", () => {
        const subject = { kind: "native", machineId: "machine", agent: { pluginId: "happier.agent.codex", localId: "codex" }, sourceRootKey: "root", nativeSessionKey: "native-session" };
        const mapped = toScopedUsageEventRow(row({ sessionId: null, metadata: { accountingSubject: { ...subject, extra: "drop" }, usageAccounting: { path: "native" } } }));
        expect(mapped.metadata).toEqual({ accountingSubject: subject, usageAccounting: { path: "native" } });
        expect(toScopedUsageEventRow(row({ metadata: { accountingSubject: { ...subject, machineId: 123 } } })).metadata).toBeUndefined();
    });
    it("maps tokens, Team attribution, request count, and parsed cost breakdown through one owner", () => {
        const mapped = toScopedUsageEventRow(row({
            requestCount: 1,
            teamCredentialResourceId: "resource-1",
            teamCredentialActorAccountId: "account-1",
            brokerMachineId: "broker-1",
            credentialDeliveryMode: "brokered",
        }));

        expect(mapped.tokens).toEqual({ input: 8, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 });
        expect(mapped.requestCount).toBe(1);
        expect(mapped.teamCredentialResourceId).toBe("resource-1");
        expect(mapped.teamCredentialActorAccountId).toBe("account-1");
        expect(mapped.brokerMachineId).toBe("broker-1");
        expect(mapped.cost.breakdown).toEqual({ input: 0.07, output: 0.04 });
    });

    it("degrades missing cost provenance to the honest unknown and none sentinels", () => {
        const mapped = toScopedUsageEventRow(row({ billingContext: null, costSource: null, reportedCostUsd: 0, estimatedCostUsd: 0, invoiceCostUsd: 0 }));

        expect(mapped.cost.billingContext).toBe("unknown");
        expect(mapped.cost.costSource).toBe("none");
    });

    it("preserves positive pre-provenance columns without interpreting default zero as free", () => {
        expect(toScopedUsageEventRow(row({ costSource: null })).cost.costSource).toBe("provider_reported");
        expect(toScopedUsageEventRow(row({ costSource: null, reportedCostUsd: 0, estimatedCostUsd: 0.1 })).cost.costSource).toBe("pricing_estimate");
        expect(toScopedUsageEventRow(row({ costSource: null, reportedCostUsd: 0, invoiceCostUsd: 0.08 })).cost.costSource).toBe("invoice");
        expect(toScopedUsageEventRow(row({ costSource: "made_up" })).cost.costSource).toBe("none");
    });

    it("does not pass non-canonical cost provenance strings through to the wire", () => {
        const mapped = toScopedUsageEventRow(row({ billingContext: "mystery", costSource: "made_up" }));

        expect(mapped.cost.billingContext).toBe("unknown");
        expect(mapped.cost.costSource).toBe("none");
    });

    it("drops malformed cost breakdown metadata without failing the row", () => {
        expect(toScopedUsageEventRow(row({ costBreakdown: "{not json" })).cost.breakdown).toBeUndefined();
        expect(toScopedUsageEventRow(row({ costBreakdown: "[1,2]" })).cost.breakdown).toBeUndefined();
        expect(toScopedUsageEventRow(row({ costBreakdown: null })).cost.breakdown).toBeUndefined();
    });
});
