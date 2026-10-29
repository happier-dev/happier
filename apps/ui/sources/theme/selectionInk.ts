import Color from 'color';

/**
 * The open tab's fill (calm-shell `cstabs.T1`): the theme's own text ink, one step above the hover
 * selection. `focused` is the open tab of the focused pane; `unfocused` is half of it, for the open
 * tab of a pane that is not focused, so focus between split panes still reads. Ink, not a grey, so it
 * sits on the canvas, a page or a custom material alike.
 */
export function deriveSelectionFocusInk(textPrimary: string, dark: boolean): Readonly<{ focused: string; unfocused: string }> {
    const alpha = dark ? 0.1 : 0.085;
    const ink = Color(textPrimary);
    return {
        focused: ink.alpha(alpha).rgb().string(),
        unfocused: ink.alpha(alpha / 2).rgb().string(),
    };
}

/**
 * The hover fill: the theme's own text ink at a lighter touch than every selection it sits beside — the
 * page's `surface.selected` and the navigation plane's elevated chip — so a row under a resting pointer
 * never reads as the open one (DESIGN.md → Materials). Ink, so it sits right on the page, the plane and
 * any custom material alike.
 */
export function deriveHoverInk(textPrimary: string, dark: boolean): string {
    return Color(textPrimary).alpha(dark ? 0.032 : 0.014).rgb().string();
}
