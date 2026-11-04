use super::placement::Rect;
use super::DesktopActivityOverlaySurface;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Dock {
    #[default]
    Top,
    Left,
    Right,
    Floating,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct FrameInput {
    pub dock: Dock,
    pub visible: Rect,
    pub top: f64,
    pub position: (f64, f64),
    pub extent: (f64, f64),
    pub screen_bounds: Option<Rect>,
    pub rest_extent: (f64, f64),
    pub surface: DesktopActivityOverlaySurface,
    pub camera_center: Option<f64>,
    pub camera_offset: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum HorizontalGrowth {
    Left,
    Right,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VerticalGrowth {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct Growth {
    pub x: Option<HorizontalGrowth>,
    pub y: Option<VerticalGrowth>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FramePresentation {
    pub dock: Dock,
    pub growth: Growth,
    pub anchor_offset: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_origin: Option<ScreenOrigin>,
}

/// Top-left in the logical screen coordinates used by destination-window rects.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenOrigin {
    pub x: f64,
    pub y: f64,
    pub scale_factor: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Frame {
    pub rect: Rect,
    pub presentation: FramePresentation,
}

impl Frame {
    pub(crate) fn presentation_in(self, envelope: Rect, scale: f64) -> FramePresentation {
        let mut presentation = self.presentation;
        presentation.anchor_offset.x += self.rect.x + self.rect.width / 2. - envelope.x - envelope.width / 2.;
        presentation.anchor_offset.y += self.rect.y + self.rect.height / 2. - envelope.y - envelope.height / 2.;
        presentation.screen_origin = Some(ScreenOrigin { x: envelope.x, y: envelope.y, scale_factor: scale });
        presentation
    }
}

pub(crate) fn frame_plan(input: FrameInput) -> Frame {
    let visible = input.visible;
    let rest_width = input.rest_extent.0.min(visible.width);
    let rest_height = input.rest_extent.1.min(visible.height);
    let x_fraction = input.position.0.clamp(0., 1.);
    let y_fraction = input.position.1.clamp(0., 1.);
    let anchor = Point {
        x: if input.dock == Dock::Top {
            input
                .camera_center
                .map(|centre| centre + input.camera_offset)
                .unwrap_or(visible.x + rest_width / 2. + (visible.width - rest_width) * x_fraction)
        } else {
            visible.x + rest_width / 2. + (visible.width - rest_width) * x_fraction
        },
        y: visible.y + rest_height / 2. + (visible.height - rest_height) * y_fraction,
    };
    let growth = match input.dock {
        Dock::Top => Growth {
            x: None,
            y: Some(VerticalGrowth::Down),
        },
        Dock::Left => Growth {
            x: Some(HorizontalGrowth::Right),
            y: None,
        },
        Dock::Right => Growth {
            x: Some(HorizontalGrowth::Left),
            y: None,
        },
        Dock::Floating => Growth {
            x: Some(if x_fraction > 0.5 {
                HorizontalGrowth::Left
            } else {
                HorizontalGrowth::Right
            }),
            y: Some(if y_fraction > 0.5 {
                VerticalGrowth::Up
            } else {
                VerticalGrowth::Down
            }),
        },
    };
    let top = if input.dock == Dock::Top {
        input.top
    } else {
        visible.y
    };
    let width = input.extent.0.min(visible.width).max(1.);
    let height = input.extent.1.min(visible.y + visible.height - top).max(1.);
    let rest_width = input.rest_extent.0.min(width);
    let rest_height = input.rest_extent.1.min(height);
    let anchor = Point {
        x: anchor.x.clamp(
            visible.x + rest_width / 2.,
            visible.x + visible.width - rest_width / 2.,
        ),
        y: if input.dock == Dock::Top {
            anchor.y
        } else {
            anchor.y.clamp(
                visible.y + rest_height / 2.,
                visible.y + visible.height - rest_height / 2.,
            )
        },
    };
    let (x, y) = match input.dock {
        Dock::Top => (anchor.x - width / 2., top),
        Dock::Left => (visible.x, anchor.y - height / 2.),
        Dock::Right => (visible.x + visible.width - width, anchor.y - height / 2.),
        Dock::Floating if input.surface.is_open() => (
            match growth.x {
                Some(HorizontalGrowth::Left) => anchor.x + rest_width / 2. - width,
                _ => anchor.x - rest_width / 2.,
            },
            match growth.y {
                Some(VerticalGrowth::Up) => anchor.y + rest_height / 2. - height,
                _ => anchor.y - rest_height / 2.,
            },
        ),
        Dock::Floating => (anchor.x - width / 2., anchor.y - height / 2.),
    };
    let rect = Rect {
        x: x.clamp(
            visible.x,
            (visible.x + visible.width - width).max(visible.x),
        ),
        y: y.clamp(top, (visible.y + visible.height - height).max(top)),
        width,
        height,
    };
    // Layer bounds extend the window, never the docked island or its anchor.
    let rect = envelope(rect, input.screen_bounds, false);
    let island_center = match input.dock {
        Dock::Top => Point {
            x: anchor.x,
            y: top + rest_height / 2.,
        },
        Dock::Left => Point {
            x: visible.x + rest_width / 2.,
            y: anchor.y,
        },
        Dock::Right => Point {
            x: visible.x + visible.width - rest_width / 2.,
            y: anchor.y,
        },
        Dock::Floating => anchor,
    };
    Frame {
        rect,
        presentation: FramePresentation {
            dock: input.dock,
            growth,
            anchor_offset: Point {
                x: island_center.x - rect.x - rect.width / 2.,
                y: island_center.y - rect.y - rect.height / 2.,
            },
            screen_origin: None,
        },
    }
}

pub(crate) fn envelope(target: Rect, previous: Option<Rect>, settled: bool) -> Rect {
    if settled {
        return target;
    }
    let Some(previous) = previous else {
        return target;
    };
    let x = target.x.min(previous.x);
    let y = target.y.min(previous.y);
    Rect {
        x,
        y,
        width: (target.x + target.width).max(previous.x + previous.width) - x,
        height: (target.y + target.height).max(previous.y + previous.height) - y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(dock: Dock) -> FrameInput {
        FrameInput {
            dock,
            visible: Rect {
                x: 20.,
                y: 30.,
                width: 1000.,
                height: 800.,
            },
            top: 0.,
            position: (0.8, 0.8),
            extent: (400., 300.),
            screen_bounds: None,
            rest_extent: (100., 40.),
            surface: DesktopActivityOverlaySurface::Expanded,
            camera_center: None,
            camera_offset: 0.,
        }
    }
    #[test]
    fn floating_in_the_bottom_half_grows_up() {
        let frame = frame_plan(input(Dock::Floating));
        assert_eq!(
            frame.presentation.growth,
            Growth {
                x: Some(HorizontalGrowth::Left),
                y: Some(VerticalGrowth::Up)
            }
        );
        assert_eq!(
            frame.rect,
            Rect {
                x: 440.,
                y: 378.,
                width: 400.,
                height: 300.
            }
        );
    }
    #[test]
    fn floating_top_left_grows_toward_the_centre_then_clamps() {
        let frame = frame_plan(FrameInput {
            position: (0., 0.),
            ..input(Dock::Floating)
        });
        assert_eq!(
            frame.presentation.growth,
            Growth {
                x: Some(HorizontalGrowth::Right),
                y: Some(VerticalGrowth::Down)
            }
        );
        assert_eq!(
            frame.rect,
            Rect {
                x: 20.,
                y: 30.,
                width: 400.,
                height: 300.
            }
        );
        assert_eq!(
            frame.presentation.anchor_offset,
            Point { x: -150., y: -130. }
        );
    }
    #[test]
    fn top_camera_centres_the_camera_block_with_asymmetric_wings() {
        let frame = frame_plan(FrameInput {
            camera_center: Some(520.),
            camera_offset: 30.,
            ..input(Dock::Top)
        });
        assert_eq!(frame.rect.x, 350.);
        assert_eq!(frame.rect.y, 0.);
        assert_eq!(
            frame.presentation.growth,
            Growth {
                x: None,
                y: Some(VerticalGrowth::Down)
            }
        );
    }
    #[test]
    fn sides_open_inward_and_use_the_visible_work_area() {
        for (dock, x, direction) in [
            (Dock::Left, 20., HorizontalGrowth::Right),
            (Dock::Right, 620., HorizontalGrowth::Left),
        ] {
            let frame = frame_plan(input(dock));
            assert_eq!(frame.rect.x, x);
            assert_eq!(
                frame.presentation.growth,
                Growth {
                    x: Some(direction),
                    y: None
                }
            );
            assert!(frame.rect.y >= 30. && frame.rect.y + frame.rect.height <= 830.);
        }
    }
    #[test]
    fn close_retains_the_envelope_until_settlement() {
        let open = Rect {
            x: 200.,
            y: 30.,
            width: 500.,
            height: 400.,
        };
        let rest = Rect {
            x: 350.,
            y: 30.,
            width: 200.,
            height: 40.,
        };
        assert_eq!(envelope(rest, Some(open), false), open);
        assert_eq!(envelope(rest, Some(open), true), rest);
        assert_eq!(envelope(open, Some(rest), false), open);
    }

    #[test]
    fn edge_positions_keep_the_entire_resting_island_inside_the_growing_envelope() {
        for position in [(0., 0.), (1., 1.)] {
            let frame = frame_plan(FrameInput {
                position,
                ..input(Dock::Floating)
            });
            let centre = Point {
                x: frame.rect.x + frame.rect.width / 2. + frame.presentation.anchor_offset.x,
                y: frame.rect.y + frame.rect.height / 2. + frame.presentation.anchor_offset.y,
            };
            assert!(centre.x - 50. >= 20. && centre.x + 50. <= 1020.);
            assert!(centre.y - 20. >= 30. && centre.y + 20. <= 830.);
        }
    }

    #[test]
    fn floating_fractions_describe_visible_frame_minus_resting_island() {
        let frame = frame_plan(FrameInput {
            position: (0.25, 0.75),
            extent: (100., 40.),
            surface: DesktopActivityOverlaySurface::Collapsed,
            ..input(Dock::Floating)
        });
        assert_eq!(frame.rect, Rect { x: 245., y: 600., width: 100., height: 40. });
    }

    #[test]
    fn layer_extent_and_retained_envelope_preserve_the_island_anchor_on_every_dock() {
        let bounds = Rect { x:-500., y:-200., width:2000., height:1400. };
        for dock in [Dock::Top, Dock::Left, Dock::Right, Dock::Floating] {
            let base = frame_plan(input(dock));
            let covered = frame_plan(FrameInput { screen_bounds:Some(bounds), ..input(dock) });
            let frame = covered.presentation_in(bounds, 2.);
            assert_eq!(covered.rect, bounds);
            assert_eq!(frame.screen_origin, Some(ScreenOrigin { x:-500., y:-200., scale_factor:2. }));
            assert_eq!(bounds.x + bounds.width / 2. + frame.anchor_offset.x,
                base.rect.x + base.rect.width / 2. + base.presentation.anchor_offset.x);
            assert_eq!(bounds.y + bounds.height / 2. + frame.anchor_offset.y,
                base.rect.y + base.rect.height / 2. + base.presentation.anchor_offset.y);
            let closing = base.presentation_in(envelope(base.rect, Some(bounds), false), 1.5);
            assert_eq!(closing.screen_origin.unwrap().x, bounds.x);
            assert_eq!(base.presentation_in(envelope(base.rect, Some(bounds), true), 1.5).screen_origin.unwrap().x, base.rect.x);
        }
    }
}
