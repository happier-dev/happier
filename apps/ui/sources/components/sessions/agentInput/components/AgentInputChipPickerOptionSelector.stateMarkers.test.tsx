import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "@/dev/testkit";
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => {
    const { createReactNativeWebMock } = await import("@/dev/testkit/mocks/reactNative");
    return createReactNativeWebMock();
});

const RUNNING = {
    id: "engine:claude",
    label: "Claude Code",
    accessibilityLabel: "Claude Code. Running this Session.",
} as const;

const ARMED = {
    id: "engine:codex",
    label: "Codex",
    accessibilityLabel: "Codex. Selected for your next message.",
} as const;

const SECTIONS = [{ id: "agents", options: [RUNNING, ARMED] }];

/**
 * Selection is carried visually by one checkmark, as in every sibling model picker.
 * A checkmark is a glyph, though, and a dimmed row is a colour — so whatever the rail
 * conveys by drawing it must also be published as state and as words, in both the
 * rail and the compact selector that has no checkmark at all.
 */
describe("AgentInputChipPickerOptionSelector state semantics", () => {
    it('keeps a rail option at the control height, grown to the shared touch floor when that is larger', async () => {
        const { AgentInputChipPickerOptionSelector } = await import('./AgentInputChipPickerOptionSelector');

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={SECTIONS}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const row = screen.findByTestId(`agent-input-chip-picker.option:${ARMED.id}`);
        const style = row?.props.style({ pressed: false }) ?? [];
        const flattened = Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean));

        expect(flattened.minHeight).toBe(Math.max(HAPPIER_PAGE_METRICS.controlHeightPx, HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE));
    });

    it('starts a labelled rail group after a divider of its own, never directly under the row above', async () => {
        const { AgentInputChipPickerOptionSelector } = await import('./AgentInputChipPickerOptionSelector');

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[
                    { id: '__default__', options: [ARMED] },
                    { id: 'notOnMachine', label: 'Not on devbox yet', options: [{ id: 'engine:claude', label: 'Claude', sectionId: 'notOnMachine', muted: true }] },
                ]}
                focusedOptionId={null}
                selectedOptionId={ARMED.id}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        expect(screen.findByTestId('agent-input-chip-picker.rail-group:notOnMachine')).toBeTruthy();
        // The first group has no heading to separate, so it draws no divider.
        expect(screen.findByTestId('agent-input-chip-picker.rail-group:__default__')).toBeFalsy();
    });

    it("publishes selection as state, and each row's own accessible name, in the rail", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={SECTIONS}
                focusedOptionId={ARMED.id}
                selectedOptionId={ARMED.id}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const running = screen.findByTestId(`agent-input-chip-picker.option:${RUNNING.id}`);
        const armed = screen.findByTestId(`agent-input-chip-picker.option:${ARMED.id}`);

        // On the web the row announces its selection as pressed (React Native Web drops accessibilityState).
        expect(armed?.props["aria-pressed"]).toBe(true);
        expect(running?.props["aria-pressed"]).toBe(false);
        // The running Agent no longer carries a marker of its own — the send button
        // names the armed target instead — but its row must still say what it is.
        expect(running?.props.accessibilityLabel).toBe(RUNNING.accessibilityLabel);
        expect(armed?.props.accessibilityLabel).toBe(ARMED.accessibilityLabel);
    });

    it("publishes a blocked row as disabled rather than only dimming it", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[{ id: "agents", options: [{ ...ARMED, disabled: true, muted: true }] }]}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        expect(
            screen.findByTestId(`agent-input-chip-picker.option:${ARMED.id}`)?.props.accessibilityState?.disabled,
        ).toBe(true);
    });

    it("gives an unselected row its own state mark, in the checkmark's own slot", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[{
                    id: "agents",
                    options: [
                        { ...RUNNING, statusMarker: React.createElement("RunningMark", { testID: "running-mark" }) },
                        ARMED,
                    ],
                }]}
                focusedOptionId={ARMED.id}
                selectedOptionId={ARMED.id}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const running = screen.findByTestId(`agent-input-chip-picker.option:${RUNNING.id}`);
        expect(running?.findAllByType("RunningMark" as never).length).toBe(1);
        // It stands IN the slot rather than beside it: the row that is the selection
        // shows a checkmark and nothing else, so a row can never show both.
        const armed = screen.findByTestId(`agent-input-chip-picker.option:${ARMED.id}`);
        expect(armed?.findAllByType("RunningMark" as never).length).toBe(0);
    });

    it('drops the state mark the moment that row becomes the selection again', async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[{
                    id: "agents",
                    options: [
                        { ...RUNNING, statusMarker: React.createElement("RunningMark", { testID: "running-mark" }) },
                        ARMED,
                    ],
                }]}
                focusedOptionId={RUNNING.id}
                selectedOptionId={RUNNING.id}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const running = screen.findByTestId(`agent-input-chip-picker.option:${RUNNING.id}`);
        expect(running?.findAllByType("RunningMark" as never).length).toBe(0);
    });

    it("publishes a blocked row as disabled rather than only dimming it", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[{ id: "agents", options: [{ ...ARMED, disabled: true, muted: true }] }]}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        expect(
            screen.findByTestId(`agent-input-chip-picker.option:${ARMED.id}`)?.props.accessibilityState?.disabled,
        ).toBe(true);
    });

    it("carries the accessible name into the compact selector, which has no checkmark", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={SECTIONS}
                focusedOptionId={ARMED.id}
                selectedOptionId={ARMED.id}
                onFocusOption={() => {}}
                variant="stacked"
            />,
        );

        // Icon-only chips: the accessible name is the only place the state can live.
        expect(
            screen.findByTestId(`agent-input-chip-picker.top-selector-option:${RUNNING.id}`)
                ?.props.accessibilityLabel,
        ).toBe(RUNNING.accessibilityLabel);
    });
    it("names the selection in the accessible name, because the rail's only marker is a glyph", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const PLAIN_SELECTED = { id: "engine:claude", label: "Claude" } as const;
        const PLAIN_OTHER = { id: "engine:codex", label: "Codex" } as const;

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[{ id: "agents", options: [PLAIN_SELECTED, PLAIN_OTHER] }]}
                focusedOptionId={PLAIN_SELECTED.id}
                selectedOptionId={PLAIN_SELECTED.id}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const selected = screen.findByTestId(`agent-input-chip-picker.option:${PLAIN_SELECTED.id}`);
        const other = screen.findByTestId(`agent-input-chip-picker.option:${PLAIN_OTHER.id}`);

        // `accessibilityState.selected` becomes `aria-selected`, which is invalid on
        // `role="button"` and is dropped before it reaches the accessibility tree, so a row
        // that only publishes state is indistinguishable from every other row.
        expect(other?.props.accessibilityLabel).toBe(PLAIN_OTHER.label);
        expect(selected?.props.accessibilityLabel).not.toBe(PLAIN_SELECTED.label);
        expect(String(selected?.props.accessibilityLabel)).toContain(PLAIN_SELECTED.label);

        // A row that already says something more precise keeps its own words.
        const explicit = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[{ id: "agents", options: [RUNNING] }]}
                focusedOptionId={RUNNING.id}
                selectedOptionId={RUNNING.id}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );
        expect(explicit.findByTestId(`agent-input-chip-picker.option:${RUNNING.id}`)?.props.accessibilityLabel)
            .toBe(RUNNING.accessibilityLabel);
    });
    it('runs a status mark\'s operation and opens its row, so the row\'s detail follows the work', async () => {
        const { AgentInputChipPickerOptionSelector } = await import('./AgentInputChipPickerOptionSelector');
        const install = vi.fn();
        const focus = vi.fn();
        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[{ id: 'notOnMachine', label: 'Not on devbox yet', options: [{ id: 'engine:pi', label: 'Pi', sectionId: 'notOnMachine', muted: true,
                    statusMarker: <></>, statusAction: { testID: 'install-pi', accessibilityLabel: 'Install Pi', onPress: install } }] }]}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={focus}
                variant="rail"
            />,
        );
        await screen.pressByTestIdAsync('install-pi');
        expect(install).toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalledWith('engine:pi');
        expect(focus).toHaveBeenCalledTimes(1);
    });
});
