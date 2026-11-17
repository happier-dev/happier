import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionInputForgeEvidenceV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { ForgeEvidenceInputCard } from './ForgeEvidenceInputCard';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(standardCleanup);

it('identifies database evidence and discloses its structured data on request', async () => {
    const evidence = SessionInputForgeEvidenceV1Schema.parse({ v: 1, items: [{
        source: { kind: 'databaseFinding', label: 'Selected database connection' },
        author: { kind: 'process' }, text: JSON.stringify({ task: 'inspect_database_schema' }),
    }] });
    const screen = await renderScreen(<ForgeEvidenceInputCard evidence={evidence} testID="database-evidence" />);
    expect(screen.getTextContent()).toContain(t('message.forgeEvidence.kind.databaseFinding'));
    expect(screen.getTextContent()).toContain('Selected database connection');
    expect(screen.getTextContent()).not.toContain('inspect_database_schema');
    expect(screen.findByProps({ name: 'server' })).toBeTruthy();
    await screen.pressByTestIdAsync('database-evidence.item.0.evidence');
    expect(screen.getTextContent()).toContain('inspect_database_schema');
    await screen.pressByTestIdAsync('database-evidence.item.0.evidence');
    expect(screen.getTextContent()).not.toContain('inspect_database_schema');
});
