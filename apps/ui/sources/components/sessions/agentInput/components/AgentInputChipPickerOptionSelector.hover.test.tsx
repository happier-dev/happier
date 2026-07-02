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

vi.mock("@/agents/registry/registryUiBehavior", () => ({
    resolveAgentUiBehavior: () => ({
        permissions: {
            footer: {
                usePermissionUpdates: false,
                forceReadOnlyAfterStop: true,
                supportsExecPolicyAmendment: false,
                stopHandling: "denyAndAbortRun",
            },
        },
        newSession: {
            supportsTranscriptStorageMode: () => false,
        },
    }),
    resolveAgentUiBehaviorFromFlavor: () => null,
    getAgentResumeExperimentsFromSettings: () => ({ enabled: true, switches: {} }),
    buildResumeCapabilityOptionsFromUiState: (opts: { settings: unknown }) => ({ accountSettings: opts.settings }),
    getNewSessionPreflightIssues: () => [],
    buildNewSessionOptionsFromUiState: () => null,
    canSelectAgentWithoutDetectedCli: () => false,
    getNewSessionAgentInputExtraActionChips: () => undefined,
    getNewSessionRelevantInstallableDepKeys: () => [],
    buildSpawnSessionExtrasFromUiState: () => ({}),
    buildSpawnEnvironmentVariablesFromUiState: (opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables,
    buildResumeSessionExtrasFromUiState: () => ({}),
    buildWakeResumeExtras: () => ({}),
    supportsDetectedMcpConfigScan: () => false,
    supportsEditableSessionGoals: () => false,
}));

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
    function flattenStyle(styleProp: unknown): Record<string, unknown> {
        const resolvedArray = Array.isArray(styleProp) ? styleProp : [styleProp];
        return Object.assign({}, ...resolvedArray.filter(Boolean));
    }

    it("shows rail option actions only while hovering and keeps action presses from focusing the row", async () => {
        const {
            AgentInputChipPickerOptionSelector,
            shouldShowAgentInputChipPickerRailAction,
        } = await import("./AgentInputChipPickerOptionSelector");
        const onActionPress = vi.fn();
        const onFocusOption = vi.fn();

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[
                    {
                        id: "sec",
                        label: "Section",
                        options: [
                            {
                                id: "engine:codex",
                                label: "Codex",
                                subtitle: "",
                                disabled: false,
                                muted: false,
                                railAction: {
                                    testID: "engine-favorite-action",
                                    accessibilityLabel: "Favorite engine",
                                    selected: false,
                                    icon: React.createElement("Icon"),
                                    onPress: onActionPress,
                                },
                            },
                        ],
                    },
                ]}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={onFocusOption}
                variant="rail"
            />,
        );

        const actionBeforeHover = screen.findByTestId("engine-favorite-action");
        expect(actionBeforeHover?.props.disabled).toBe(true);

        expect(shouldShowAgentInputChipPickerRailAction({
            canRender: true,
            hovered: true,
            focused: false,
        })).toBe(true);

        actionBeforeHover?.props.onPress?.({ stopPropagation: vi.fn() });

        expect(onActionPress).toHaveBeenCalledTimes(1);
        expect(onFocusOption).not.toHaveBeenCalled();
    });

    it("uses a non-button web row wrapper when an option has a nested rail action", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");
        const onFocusOption = vi.fn();

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[
                    {
                        id: "sec",
                        label: "Section",
                        options: [
                            {
                                id: "engine:codex",
                                label: "Codex",
                                subtitle: "",
                                disabled: false,
                                muted: false,
                                railAction: {
                                    testID: "engine-favorite-action",
                                    accessibilityLabel: "Favorite engine",
                                    selected: false,
                                    icon: React.createElement("Icon"),
                                    onPress: vi.fn(),
                                },
                            },
                        ],
                    },
                ]}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={onFocusOption}
                variant="rail"
            />,
        );

        const row = screen.findByTestId("agent-input-chip-picker.option:engine:codex");
        expect(row).toBeTruthy();
        if (!row) {
            throw new Error("Expected option row to render");
        }
        expect(row.type).toBe("View");
        expect(row.props.accessibilityRole).toBeUndefined();
        expect(row.props.tabIndex).toBe(0);

        await screen.pressByTestIdAsync("agent-input-chip-picker.option:engine:codex");

        expect(onFocusOption).toHaveBeenCalledWith("engine:codex");
    });

    it("keeps selected rail option actions hidden until the selected row is hovered", async () => {
        const {
            AgentInputChipPickerOptionSelector,
            shouldShowAgentInputChipPickerRailAction,
        } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[
                    {
                        id: "sec",
                        label: "Section",
                        options: [
                            {
                                id: "engine:codex",
                                label: "Codex",
                                subtitle: "",
                                disabled: false,
                                muted: false,
                                railAction: {
                                    testID: "engine-favorite-action",
                                    accessibilityLabel: "Remove favorite engine",
                                    selected: true,
                                    icon: React.createElement("Icon"),
                                    onPress: vi.fn(),
                                },
                            },
                        ],
                    },
                ]}
                focusedOptionId="engine:codex"
                selectedOptionId="engine:codex"
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const selectedActionBeforeHover = screen.findByTestId("engine-favorite-action");
        expect(selectedActionBeforeHover?.props.disabled).toBe(true);

        expect(shouldShowAgentInputChipPickerRailAction({
            canRender: true,
            hovered: false,
            focused: true,
        })).toBe(false);
        expect(shouldShowAgentInputChipPickerRailAction({
            canRender: true,
            hovered: true,
            focused: true,
        })).toBe(true);
    });

    it("keeps rail option actions visually compact", async () => {
        const { AgentInputChipPickerOptionSelector } = await import("./AgentInputChipPickerOptionSelector");

        const screen = await renderScreen(
            <AgentInputChipPickerOptionSelector
                sections={[
                    {
                        id: "sec",
                        label: "Section",
                        options: [
                            {
                                id: "engine:codex",
                                label: "Codex",
                                subtitle: "",
                                disabled: false,
                                muted: false,
                                railAction: {
                                    testID: "engine-favorite-action",
                                    accessibilityLabel: "Favorite engine",
                                    selected: false,
                                    icon: React.createElement("Icon"),
                                    onPress: vi.fn(),
                                },
                            },
                        ],
                    },
                ]}
                focusedOptionId={null}
                selectedOptionId={null}
                onFocusOption={() => {}}
                variant="rail"
            />,
        );

        const action = screen.findByTestId("engine-favorite-action");
        expect(flattenStyle(action?.props.style)).toMatchObject({
            width: 20,
            height: 20,
        });
    });

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
