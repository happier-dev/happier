import React from "react";
import Color from "color";
import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "@/dev/testkit";
import { lightTheme } from "@/theme";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => {
    const { createReactNativeWebMock } = await import("@/dev/testkit/mocks/reactNative");
    return createReactNativeWebMock();
});

function flattenStyleFromCallback(
    styleProp: unknown,
    state: { pressed: boolean; hovered?: boolean },
): Record<string, unknown> {
    if (typeof styleProp !== "function") {
        throw new Error("Expected style prop to be a function");
    }
    const resolved = (styleProp as (s: any) => unknown)(state);
    const resolvedArray = Array.isArray(resolved) ? resolved : [resolved];
    return Object.assign({}, ...resolvedArray.filter(Boolean));
}

describe("AgentInputChipPickerOptionSelector (hover)", () => {
    it("applies a hover background on web option rows", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[
                    {
                        id: "sec",
                        label: "Section",
                        options: [
                            { id: "a", label: "A", subtitle: "", disabled: false, muted: false },
                            { id: "b", label: "B", subtitle: "", disabled: false, muted: false },
                        ],
                    },
                ]}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const row = screen.findByTestId("agent-input-chip-picker.option:b");
        if (!row) {
            throw new Error("Expected option row to render");
        }

        const base = flattenStyleFromCallback(row.props.style, { pressed: false, hovered: false });
        expect(base.backgroundColor).toBe("transparent");

        const hovered = flattenStyleFromCallback(row.props.style, { pressed: false, hovered: true });
        const expected = Color(lightTheme.colors.surface.base).alpha(0.8).rgb().string();
        expect(hovered.backgroundColor).toBe(expected);
    });
});

