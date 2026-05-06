use super::host_mode::{DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode};
use super::placement::{clamp, OverlayPlacementRect, Rect};
use super::{
    DesktopActivityOverlayDimensionsPayload, DesktopActivityOverlayWindowDimensionsPayload,
};

const NOTCH_COLLAPSED_TOTAL_WING_WIDTH_PX: f64 = 60.0;
const NOTCH_COLLAPSED_HIT_TEST_HORIZONTAL_PADDING_PX: f64 = 10.0;
const NOTCH_COLLAPSED_HIT_TEST_VERTICAL_PADDING_PX: f64 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DesktopActivityOverlayNativeMousePoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DesktopActivityOverlayNativeMouseState {
    hover_started_at_ms: Option<u64>,
    previous_left_mouse_pressed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopActivityOverlayNativeMouseEffect {
    None,
    ExpandFromClick,
    ExpandFromHover,
    CollapseFromOutsideClick,
}

pub(crate) fn resolve_notch_integrated_window_dimensions(
    window: DesktopActivityOverlayWindowDimensionsPayload,
    expanded: bool,
    host_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> DesktopActivityOverlayDimensionsPayload {
    if expanded {
        return clamp_dimensions_to_display(window.expanded, display_context);
    }

    if !matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated) {
        return clamp_dimensions_to_display(window.collapsed, display_context);
    }

    let Some(display_context) = display_context else {
        return window.collapsed;
    };

    let Some(physical_notch_size) = display_context.physical_notch_size else {
        return window.collapsed;
    };

    let target_width = physical_notch_size.width + NOTCH_COLLAPSED_TOTAL_WING_WIDTH_PX;
    DesktopActivityOverlayDimensionsPayload {
        width: clamp(
            target_width,
            physical_notch_size.width,
            display_context
                .screen_frame
                .width
                .max(physical_notch_size.width),
        ),
        height: clamp(physical_notch_size.height, 1.0, window.collapsed.height),
    }
}

fn clamp_dimensions_to_display(
    dimensions: DesktopActivityOverlayDimensionsPayload,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> DesktopActivityOverlayDimensionsPayload {
    let Some(display_context) = display_context else {
        return dimensions;
    };

    DesktopActivityOverlayDimensionsPayload {
        width: clamp(
            dimensions.width,
            1.0,
            display_context.visible_frame.width.max(1.0),
        ),
        height: clamp(
            dimensions.height,
            1.0,
            display_context.visible_frame.height.max(1.0),
        ),
    }
}

pub(crate) fn resolve_notch_integrated_hit_rect(
    placement: OverlayPlacementRect,
    dimensions: DesktopActivityOverlayDimensionsPayload,
    display_context: DesktopActivityOverlayDisplayContext,
    applied_native_frame: Option<Rect>,
) -> Rect {
    let base_rect = resolve_notch_integrated_panel_rect(
        placement,
        dimensions,
        display_context,
        applied_native_frame,
    );

    Rect {
        x: base_rect.x - NOTCH_COLLAPSED_HIT_TEST_HORIZONTAL_PADDING_PX,
        y: base_rect.y - NOTCH_COLLAPSED_HIT_TEST_VERTICAL_PADDING_PX,
        width: base_rect.width + NOTCH_COLLAPSED_HIT_TEST_HORIZONTAL_PADDING_PX * 2.0,
        height: base_rect.height + NOTCH_COLLAPSED_HIT_TEST_VERTICAL_PADDING_PX * 2.0,
    }
}

pub(crate) fn resolve_notch_integrated_panel_rect(
    placement: OverlayPlacementRect,
    dimensions: DesktopActivityOverlayDimensionsPayload,
    display_context: DesktopActivityOverlayDisplayContext,
    applied_native_frame: Option<Rect>,
) -> Rect {
    applied_native_frame.unwrap_or_else(|| Rect {
        x: placement.x,
        y: display_context.screen_frame.y + display_context.screen_frame.height
            - placement.y
            - dimensions.height,
        width: dimensions.width,
        height: dimensions.height,
    })
}

pub(crate) fn advance_notch_native_mouse_state(
    state: &mut DesktopActivityOverlayNativeMouseState,
    hit_rect: Rect,
    point: DesktopActivityOverlayNativeMousePoint,
    left_mouse_pressed: bool,
    now_ms: u64,
    hover_expand_delay_ms: u64,
) -> DesktopActivityOverlayNativeMouseEffect {
    let point_is_inside = rect_contains_point(hit_rect, point);
    let pressed_edge = left_mouse_pressed && !state.previous_left_mouse_pressed;
    state.previous_left_mouse_pressed = left_mouse_pressed;

    if !point_is_inside {
        state.hover_started_at_ms = None;
        return DesktopActivityOverlayNativeMouseEffect::None;
    }

    if pressed_edge {
        state.hover_started_at_ms = Some(now_ms);
        return DesktopActivityOverlayNativeMouseEffect::ExpandFromClick;
    }

    let hover_started_at_ms = *state.hover_started_at_ms.get_or_insert(now_ms);
    if now_ms.saturating_sub(hover_started_at_ms) >= hover_expand_delay_ms {
        state.hover_started_at_ms = Some(now_ms);
        return DesktopActivityOverlayNativeMouseEffect::ExpandFromHover;
    }

    DesktopActivityOverlayNativeMouseEffect::None
}

pub(crate) fn advance_expanded_notch_native_mouse_state(
    state: &mut DesktopActivityOverlayNativeMouseState,
    expanded_rect: Rect,
    point: DesktopActivityOverlayNativeMousePoint,
    left_mouse_pressed: bool,
) -> DesktopActivityOverlayNativeMouseEffect {
    state.hover_started_at_ms = None;
    let pressed_edge = left_mouse_pressed && !state.previous_left_mouse_pressed;
    state.previous_left_mouse_pressed = left_mouse_pressed;

    if pressed_edge && !rect_contains_point(expanded_rect, point) {
        return DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick;
    }

    DesktopActivityOverlayNativeMouseEffect::None
}

fn rect_contains_point(rect: Rect, point: DesktopActivityOverlayNativeMousePoint) -> bool {
    point.x >= rect.x
        && point.x <= rect.x + rect.width
        && point.y >= rect.y
        && point.y <= rect.y + rect.height
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_overlay::host_mode::{
        DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode,
        DesktopActivityOverlayPhysicalNotchSize,
    };
    use crate::activity_overlay::placement::{OverlayPlacementRect, Rect};
    use crate::activity_overlay::{
        DesktopActivityOverlayDimensionsPayload, DesktopActivityOverlayWindowDimensionsPayload,
    };

    fn display_context() -> DesktopActivityOverlayDisplayContext {
        DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 38.0,
            physical_notch_size: Some(DesktopActivityOverlayPhysicalNotchSize {
                width: 224.0,
                height: 38.0,
            }),
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 944.0,
            },
        }
    }

    #[test]
    fn collapsed_notch_dimensions_use_physical_notch_plus_dense_wings() {
        let dimensions = resolve_notch_integrated_window_dimensions(
            DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 304.0,
                    height: 44.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 408.0,
                    height: 240.0,
                },
            },
            false,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(display_context()),
        );

        assert_eq!(
            dimensions,
            DesktopActivityOverlayDimensionsPayload {
                width: 284.0,
                height: 38.0,
            }
        );
    }

    #[test]
    fn collapsed_notch_dimensions_keep_visible_wings_even_when_physical_notch_exceeds_payload() {
        let mut context = display_context();
        context.physical_notch_size = Some(DesktopActivityOverlayPhysicalNotchSize {
            width: 260.0,
            height: 38.0,
        });

        let dimensions = resolve_notch_integrated_window_dimensions(
            DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 254.0,
                    height: 38.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 408.0,
                    height: 240.0,
                },
            },
            false,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(context),
        );

        assert_eq!(
            dimensions,
            DesktopActivityOverlayDimensionsPayload {
                width: 320.0,
                height: 38.0,
            }
        );
    }

    #[test]
    fn collapsed_notch_dimensions_do_not_grow_taller_than_the_payload() {
        let mut context = display_context();
        context.physical_notch_size = Some(DesktopActivityOverlayPhysicalNotchSize {
            width: 224.0,
            height: 74.0,
        });

        let dimensions = resolve_notch_integrated_window_dimensions(
            DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 254.0,
                    height: 38.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 408.0,
                    height: 240.0,
                },
            },
            false,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(context),
        );

        assert_eq!(
            dimensions,
            DesktopActivityOverlayDimensionsPayload {
                width: 284.0,
                height: 38.0,
            },
        );
    }

    #[test]
    fn expanded_and_floating_dimensions_keep_the_payload_size() {
        let window = DesktopActivityOverlayWindowDimensionsPayload {
            collapsed: DesktopActivityOverlayDimensionsPayload {
                width: 304.0,
                height: 38.0,
            },
            expanded: DesktopActivityOverlayDimensionsPayload {
                width: 408.0,
                height: 240.0,
            },
        };

        assert_eq!(
            resolve_notch_integrated_window_dimensions(
                window.clone(),
                true,
                DesktopActivityOverlayHostMode::NotchIntegrated,
                Some(display_context()),
            ),
            window.expanded,
        );
        assert_eq!(
            resolve_notch_integrated_window_dimensions(
                window,
                false,
                DesktopActivityOverlayHostMode::Floating,
                Some(display_context()),
            ),
            DesktopActivityOverlayDimensionsPayload {
                width: 304.0,
                height: 38.0,
            },
        );
    }

    #[test]
    fn expanded_dimensions_clamp_to_the_visible_frame_when_display_context_is_available() {
        let dimensions = resolve_notch_integrated_window_dimensions(
            DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 304.0,
                    height: 38.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 2_400.0,
                    height: 1_200.0,
                },
            },
            true,
            DesktopActivityOverlayHostMode::Floating,
            Some(display_context()),
        );

        assert_eq!(
            dimensions,
            DesktopActivityOverlayDimensionsPayload {
                width: 1512.0,
                height: 944.0,
            },
        );
    }

    #[test]
    fn native_hit_rect_uses_the_applied_panel_frame_with_reference_padding() {
        let hit_rect = resolve_notch_integrated_hit_rect(
            OverlayPlacementRect { x: 629.0, y: 0.0 },
            DesktopActivityOverlayDimensionsPayload {
                width: 254.0,
                height: 38.0,
            },
            display_context(),
            Some(Rect {
                x: 629.0,
                y: 944.0,
                width: 254.0,
                height: 38.0,
            }),
        );

        assert_eq!(
            hit_rect,
            Rect {
                x: 619.0,
                y: 939.0,
                width: 274.0,
                height: 48.0,
            },
        );
    }

    #[test]
    fn native_mouse_state_expands_after_sustained_hover_without_webview_hover() {
        let mut state = DesktopActivityOverlayNativeMouseState::default();
        let hit_rect = Rect {
            x: 619.0,
            y: 939.0,
            width: 274.0,
            height: 48.0,
        };
        let point = DesktopActivityOverlayNativeMousePoint { x: 700.0, y: 960.0 };

        assert_eq!(
            advance_notch_native_mouse_state(&mut state, hit_rect, point, false, 1_000, 500),
            DesktopActivityOverlayNativeMouseEffect::None,
        );
        assert_eq!(
            advance_notch_native_mouse_state(&mut state, hit_rect, point, false, 1_499, 500),
            DesktopActivityOverlayNativeMouseEffect::None,
        );
        assert_eq!(
            advance_notch_native_mouse_state(&mut state, hit_rect, point, false, 1_500, 500),
            DesktopActivityOverlayNativeMouseEffect::ExpandFromHover,
        );
    }

    #[test]
    fn native_mouse_state_expands_immediately_on_collapsed_click() {
        let mut state = DesktopActivityOverlayNativeMouseState::default();
        let hit_rect = Rect {
            x: 619.0,
            y: 939.0,
            width: 274.0,
            height: 48.0,
        };

        assert_eq!(
            advance_notch_native_mouse_state(
                &mut state,
                hit_rect,
                DesktopActivityOverlayNativeMousePoint { x: 700.0, y: 960.0 },
                true,
                1_000,
                500,
            ),
            DesktopActivityOverlayNativeMouseEffect::ExpandFromClick,
        );
        assert_eq!(
            advance_notch_native_mouse_state(
                &mut state,
                hit_rect,
                DesktopActivityOverlayNativeMousePoint { x: 700.0, y: 960.0 },
                true,
                1_010,
                500,
            ),
            DesktopActivityOverlayNativeMouseEffect::None,
        );
    }

    #[test]
    fn expanded_native_mouse_state_collapses_on_left_click_outside_expanded_rect() {
        let mut state = DesktopActivityOverlayNativeMouseState::default();
        let expanded_rect = Rect {
            x: 552.0,
            y: 704.0,
            width: 408.0,
            height: 240.0,
        };

        assert_eq!(
            advance_expanded_notch_native_mouse_state(
                &mut state,
                expanded_rect,
                DesktopActivityOverlayNativeMousePoint { x: 540.0, y: 780.0 },
                true,
            ),
            DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick,
        );
    }

    #[test]
    fn expanded_native_mouse_state_keeps_open_on_left_click_inside_expanded_rect() {
        let mut state = DesktopActivityOverlayNativeMouseState::default();
        let expanded_rect = Rect {
            x: 552.0,
            y: 704.0,
            width: 408.0,
            height: 240.0,
        };

        assert_eq!(
            advance_expanded_notch_native_mouse_state(
                &mut state,
                expanded_rect,
                DesktopActivityOverlayNativeMousePoint { x: 700.0, y: 780.0 },
                true,
            ),
            DesktopActivityOverlayNativeMouseEffect::None,
        );
    }
}
