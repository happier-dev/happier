import * as React from 'react';

import type {
    AgentInputCollapsedOptionsPopover,
    AgentInputExtraActionChip,
} from '@/components/sessions/agentInput/agentInputContracts';
import type {
    SelectionListOption,
    SelectionListSection,
    SelectionListStep,
} from '@/components/ui/selectionList';

/**
 * Typed selectors for traversing the new-session checkout chip's
 * `collapsedOptionsPopover.rootStep.sections` SelectionList tree.
 *
 * These helpers replace broad untyped casts that previously littered the
 * draft-persistence test suite when asserting against the migrated checkout
 * chip (chip-picker -> SelectionList).
 *
 * The model under test exposes `simpleProps.agentInputExtraActionChips`, a
 * readonly array typed as `AgentInputExtraActionChip[]`. Tests typically work
 * against the loosely-typed hook return (`unknown`/`any`), so the helpers
 * accept the chip array via a permissive `unknown` and narrow internally.
 */

type MaybeChipsModel = {
    simpleProps?: {
        agentInputExtraActionChips?: ReadonlyArray<AgentInputExtraActionChip>;
    };
};

const CHECKOUT_CHIP_KEY = 'new-session-checkout';

/** Find the canonical checkout chip in the new-session model. */
export function findCheckoutChip(model: unknown): AgentInputExtraActionChip | undefined {
    const chips = (model as MaybeChipsModel | undefined)?.simpleProps?.agentInputExtraActionChips;
    if (!chips) return undefined;
    return chips.find((chip) => chip?.key === CHECKOUT_CHIP_KEY);
}

/**
 * Returns the `collapsedOptionsPopover` descriptor on the checkout chip, or
 * `undefined` when the chip is absent or has no popover descriptor.
 */
export function getCheckoutChipCollapsedPopover(model: unknown): AgentInputCollapsedOptionsPopover | undefined {
    return findCheckoutChip(model)?.collapsedOptionsPopover;
}

function getSelectionListRootStepFromChip(chip: AgentInputExtraActionChip | null | undefined): SelectionListStep | undefined {
    const popover = chip?.collapsedOptionsPopover;
    if (!popover || popover.presentation !== 'list') return undefined;
    return popover.rootStep;
}

/**
 * Returns the SelectionList root step on the checkout chip's collapsed
 * popover when the popover is presented as a SelectionList. Returns
 * `undefined` for `presentation: 'picker'` (the legacy chip-picker rail).
 */
export function getCheckoutChipRootStep(model: unknown): SelectionListStep | undefined {
    return getSelectionListRootStepFromChip(findCheckoutChip(model));
}

/**
 * Variant for tests that exercise `useNewSessionCheckoutActionChip` directly
 * and already hold the checkout chip instead of a full screen model.
 */
export function getCheckoutChipRootStepFromChip(chip: AgentInputExtraActionChip | null | undefined): SelectionListStep | undefined {
    return getSelectionListRootStepFromChip(chip);
}

function getStaticSectionFromRootStep(rootStep: SelectionListStep | undefined, sectionId: string): SelectionListSection | undefined {
    if (!rootStep) return undefined;
    const descriptor = rootStep.sections.find((section) => section.id === sectionId);
    if (!descriptor || descriptor.kind !== 'static') return undefined;
    return descriptor;
}

/**
 * Returns the static `SelectionListSection` matching `sectionId` from the
 * checkout chip's root step, or `undefined` if absent / dynamic.
 *
 * The checkout chip exposes its option-bearing sections as `kind: 'static'`
 * descriptors, so dynamic resolvers are intentionally filtered out.
 */
export function getCheckoutChipStaticSection(model: unknown, sectionId: string): SelectionListSection | undefined {
    return getStaticSectionFromRootStep(getCheckoutChipRootStep(model), sectionId);
}

/** Direct-chip variant of `getCheckoutChipStaticSection`. */
export function getCheckoutChipStaticSectionFromChip(
    chip: AgentInputExtraActionChip | null | undefined,
    sectionId: string,
): SelectionListSection | undefined {
    return getStaticSectionFromRootStep(getCheckoutChipRootStepFromChip(chip), sectionId);
}

/** Convenience: returns the static section's options or an empty array. */
export function getCheckoutChipSectionOptions(model: unknown, sectionId: string): ReadonlyArray<SelectionListOption> {
    return getCheckoutChipStaticSection(model, sectionId)?.options ?? [];
}

/** Direct-chip variant of `getCheckoutChipSectionOptions`. */
export function getCheckoutChipSectionOptionsFromChip(
    chip: AgentInputExtraActionChip | null | undefined,
    sectionId: string,
): ReadonlyArray<SelectionListOption> {
    return getCheckoutChipStaticSectionFromChip(chip, sectionId)?.options ?? [];
}

/** Direct-chip option lookup for the SelectionList checkout chip tree. */
export function findCheckoutChipOptionFromChip(
    chip: AgentInputExtraActionChip | null | undefined,
    sectionId: string,
    optionId: string,
): SelectionListOption | undefined {
    return getCheckoutChipSectionOptionsFromChip(chip, sectionId).find((option) => option.id === optionId);
}

/** Quick-action option IDs in the `worktree:quick-actions` section. */
export function getCheckoutChipQuickActionIds(model: unknown): string[] {
    return getCheckoutChipSectionOptions(model, 'worktree:quick-actions').map((option) => option.id);
}

/** Existing-worktree option IDs in the `worktree:existing` section. */
export function getCheckoutChipExistingWorktreeIds(model: unknown): string[] {
    return getCheckoutChipSectionOptions(model, 'worktree:existing').map((option) => option.id);
}

/**
 * Returns the checkout chip's label (from popover descriptor when set,
 * falling back to the chip's `collapsedAction` action items, and finally
 * to its rendered output).
 *
 * Kept here for parity with the previous file-local helper; the
 * `collapsedAction` and render-fallback branches still rely on permissive
 * runtime shape inspection because those code paths intentionally accept a
 * variety of action shapes upstream.
 */
export function getCheckoutChipLabel(model: unknown): React.ReactNode {
    const chip = findCheckoutChip(model);
    if (!chip) return undefined;

    const labelFromPopover = chip.collapsedOptionsPopover?.label;
    if (typeof labelFromPopover === 'string' && labelFromPopover.length > 0) {
        return labelFromPopover;
    }

    if (typeof chip.collapsedAction === 'function') {
        const action = chip.collapsedAction({
            tint: '#000',
            dismiss: () => {},
            blurInput: () => {},
        });
        const item = Array.isArray(action) ? action[0] : action;
        const label = (item as { label?: unknown } | undefined)?.label;
        if (typeof label === 'string' && label.length > 0) return label;
    }

    const chipElement = chip.render({
        chipStyle: () => null,
        showLabel: true,
        iconColor: '#000',
        textStyle: {},
        countTextStyle: {},
        popoverAnchorRef: { current: null },
    }) as React.ReactElement<{ children?: React.ReactNode }> | undefined;
    if (!chipElement) return undefined;
    const renderedChildren = React.Children.toArray(chipElement.props?.children);
    const textNode = renderedChildren.find((child): child is React.ReactElement<{ children?: React.ReactNode }> => (
        typeof child === 'object' && child !== null && 'props' in child
            && Boolean((child as React.ReactElement<{ children?: React.ReactNode }>).props?.children)
    ));
    return textNode?.props?.children;
}
