import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "@/dev/testkit";

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

        expect(armed?.props.accessibilityState?.selected).toBe(true);
        expect(running?.props.accessibilityState?.selected).toBe(false);
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
});
