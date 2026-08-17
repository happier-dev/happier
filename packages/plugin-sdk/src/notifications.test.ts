import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import type { PluginNotificationSendResult } from './activation.js';
import type {
    NotificationBatchResult,
    NotificationCategorySummary,
    NotificationChannelSummary,
} from './notifications.js';
import type {
    PluginNotificationBatchResult,
    PluginNotificationDeliveryResult,
} from './services/resources.js';

describe('notification declaration ownership', () => {
    it('keeps the public notifications path on host-mediated service outcomes', async () => {
        const sourceText = await readFile(
            new URL('./notifications/index.ts', import.meta.url),
            'utf8',
        );
        const sourceFile = ts.createSourceFile(
            'notifications/index.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedNames = sourceFile.statements.flatMap((statement) => (
            ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((element) => element.name.text)
                : []
        ));

        expect(exportedNames.sort()).toEqual([
            'NotificationBatchResult',
            'NotificationCategoryContribution',
            'NotificationCategorySummary',
            'NotificationChannelContribution',
            'NotificationChannelSummary',
            'NotificationPreferences',
            'NotificationSendRequest',
            'NotificationSendResult',
            'NotificationSender',
            'NotificationsService',
            'PluginNotificationRegistrationApi',
        ].sort());
    });

    it('uses the sender result as the canonical delivery identity', async () => {
        const sourceText = await readFile(
            new URL('./services/resources.ts', import.meta.url),
            'utf8',
        );
        const sourceFile = ts.createSourceFile(
            'services/resources.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const aliases = new Map(sourceFile.statements.flatMap((statement) => (
            ts.isTypeAliasDeclaration(statement)
                ? [[statement.name.text, statement] as const]
                : []
        )));

        expect(aliases.get('PluginNotificationSendResult')).toBeDefined();
        expect(aliases.get('PluginNotificationDeliveryResult')?.type.getText(sourceFile))
            .toBe('PluginNotificationSendResult');
        expectTypeOf<PluginNotificationDeliveryResult>()
            .toEqualTypeOf<PluginNotificationSendResult>();
        expectTypeOf<PluginNotificationBatchResult['deliveries'][number]>()
            .toEqualTypeOf<PluginNotificationSendResult>();
        expectTypeOf<NotificationBatchResult>()
            .toEqualTypeOf<PluginNotificationBatchResult>();
        expectTypeOf<NotificationCategorySummary>().toHaveProperty('defaultChannelIds');
        expectTypeOf<NotificationChannelSummary>().toHaveProperty('state');
    });
});
