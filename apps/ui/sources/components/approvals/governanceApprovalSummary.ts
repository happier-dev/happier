import type { GovernanceApprovalSummary } from '@happier-dev/protocol/actions/specs/definition';
import { findActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { t } from '@/text';
import { resolveActionTitle } from '@/text/actionTitles';
import { joinList } from '@/utils/text/joinList';
import { readWidgetGroupTitle } from '@/components/widgets/group/widgetGroupTitle';

function formatSetupSummary(setup: Extract<GovernanceApprovalSummary, { kind: 'teamSetup' }>['setup']): string {
    const checkoutLabels = {
        attach: t('actionConfirmations.governance.setupAttach'),
        clone: t('actionConfirmations.governance.setupClone'),
        sync: t('actionConfirmations.governance.setupSync'),
        worktree: t('actionConfirmations.governance.setupWorktree'),
    };
    return [
        ...(setup.machine?.targets.flatMap(target => [
            `${t('actionConfirmations.governance.setupApply')} · ${target.preset?.revision ?? target.desiredRevision}`,
            ...target.recipePlans.flatMap(({ plan }) => plan.steps.flatMap(step =>
                step.review ? [resolvePluginLocalizedStringV2Text(step.review.title)] : [])),
            ...(target.removeItemKeys?.length ? [t('machinePresets.setup.review.toRemove', { count: target.removeItemKeys.length })] : []),
            ...(target.appChildren ?? []).map(child => resolveActionTitle(child.actionId, findActionSpec(child.actionId) ?? null)),
        ]) ?? []),
        ...setup.repositories.map(({ input }) => {
            const source = input.source.kind === 'folder' ? input.source.path
                : input.source.kind === 'workspace' ? input.source.checkout?.rootPath ?? t('actionConfirmations.governance.setupWorkspace')
                : [input.source.selector.repository.nameWithOwner, input.source.selector.provider.baseUrl,
                    input.source.kind === 'source' && (input.source.checkoutPath ?? input.source.checkout?.rootPath)].filter(Boolean).join(' · ');
            const checkout = input.materialization;
            const destination = checkout.kind === 'clone'
                ? `${checkout.destinationParentPath}/${checkout.destinationDirectoryName}`
                : checkout.kind === 'sync' ? checkout.targetPath
                    : checkout.kind === 'worktree' ? checkout.targetPath ?? checkout.checkout.displayName : undefined;
            const ref = input.ref ?? (input.source.kind === 'source' ? input.source.defaultRef : undefined);
            return [
                [checkoutLabels[checkout.kind], source, ref ? `@${ref}` : null].filter(Boolean).join(' '),
                destination ? `→ ${destination}` : null,
                checkout.kind === 'clone' && checkout.authentication === 'connected_account'
                    ? t('actionConfirmations.governance.setupConnectedAccount') : null,
            ].filter(Boolean).join(' · ');
        }),
    ].join('\n');
}

/** The spec selects the consequences. The UI owns the words used to review them. */
export function formatPendingGovernanceSummary(summary: GovernanceApprovalSummary, homeLayoutWidgets?: readonly string[]): string {
    switch (summary.kind) {
        case 'teamArchive': return t('actionConfirmations.governance.teamArchive');
        case 'homeLayout': {
            const { effect } = summary;
            if (effect.kind !== 'groupCreate') return t(`actionConfirmations.governance.homeLayout.${effect.kind}`);
            const widgets = homeLayoutWidgets ?? effect.widgetIds.map(() => t('common.unavailable'));
            const group = readWidgetGroupTitle(effect) ?? t('common.unavailable');
            return t('actionConfirmations.governance.homeLayout.groupCreate', { group, widgets: joinList(widgets) });
        }
        case 'nativeCredentialDelivery': return t('actionConfirmations.governance.nativeCredentialDelivery');
        case 'machinePresetPrepare': return t('actionConfirmations.governance.machinePresetPrepare');
        case 'teamPolicy': return [
            summary.signIn === 'inherit' ? t('actionConfirmations.governance.teamPolicyInherit')
                : summary.signIn === 'inheritMayExpand' ? t('actionConfirmations.governance.teamPolicyInheritMayExpand') : null,
            summary.clearTeamDefaults ? t('actionConfirmations.governance.teamPolicyClearTeam') : null,
            summary.clearGroupDefaults ? t('actionConfirmations.governance.teamPolicyClearGroup') : null,
        ].filter(Boolean).join(' ');
        case 'teamSetup': return formatSetupSummary(summary.setup);
    }
}
