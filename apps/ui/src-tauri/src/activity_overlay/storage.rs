use super::dock::{Dock, FrameInput, Point};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, Manager, Runtime};

/// Device-owned fractions of each display's available island travel area.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotchPositionRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub floating: Option<NotchFloatingPosition>,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct NotchFloatingPosition {
    pub x: f64,
    pub y: f64,
}
pub(crate) type NotchPositions = std::collections::BTreeMap<String, NotchPositionRecord>;

pub(crate) fn position_for_dock(record: Option<&NotchPositionRecord>, dock: Dock) -> (f64, f64) {
    match dock {
        Dock::Top => (record.and_then(|r| r.top).unwrap_or(0.5), 0.5),
        Dock::Left => (0.5, record.and_then(|r| r.left).unwrap_or(0.5)),
        Dock::Right => (0.5, record.and_then(|r| r.right).unwrap_or(0.5)),
        Dock::Floating => record
            .and_then(|r| r.floating)
            .map(|p| (p.x, p.y))
            .unwrap_or((0.5, 0.5)),
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum NotchMovePosition {
    Along(f64),
    Floating(NotchFloatingPosition),
}

pub(crate) fn validate_move(
    position: Option<NotchMovePosition>,
    delta: Option<Point>,
) -> Result<(), String> {
    match (position, delta) {
        (Some(NotchMovePosition::Along(value)), None) if value.is_finite() => Ok(()),
        (Some(NotchMovePosition::Floating(point)), None)
            if point.x.is_finite() && point.y.is_finite() =>
        {
            Ok(())
        }
        (None, Some(point)) if point.x.is_finite() && point.y.is_finite() => Ok(()),
        _ => Err("Supply one finite notch position or delta".into()),
    }
}

pub(crate) fn update_notch_position(
    positions: &mut NotchPositions,
    key: &str,
    name: &str,
    input: FrameInput,
    position: Option<NotchMovePosition>,
    delta: Option<Point>,
    commit: bool,
    persist: impl FnOnce(&NotchPositions) -> Result<(), String>,
) -> Result<bool, String> {
    if input.dock == Dock::Top && input.camera_center.is_some() {
        return Ok(false);
    }
    let mut next = input.position;
    match position {
        Some(NotchMovePosition::Along(value)) => match input.dock {
            Dock::Top => next.0 = value,
            Dock::Left | Dock::Right => next.1 = value,
            Dock::Floating => return Err("Floating notch position requires x and y".into()),
        },
        Some(NotchMovePosition::Floating(point)) if input.dock == Dock::Floating => {
            next = (point.x, point.y)
        }
        Some(NotchMovePosition::Floating(_)) => {
            return Err("Docked notch position requires an along-edge fraction".into())
        }
        None => {
            let delta = delta.expect("validated movement has one input");
            match input.dock {
                Dock::Top | Dock::Floating => {
                    next.0 += travel_fraction(delta.x, input.visible.width, input.rest_extent.0)
                }
                _ => {}
            }
            match input.dock {
                Dock::Left | Dock::Right | Dock::Floating => {
                    next.1 += travel_fraction(delta.y, input.visible.height, input.rest_extent.1)
                }
                _ => {}
            }
        }
    }
    // Keep pointer overshoot during a gesture; the frame owner clamps the visual
    // position, and returning toward the display preserves the original grab.
    let next = if commit {
        (next.0.clamp(0., 1.), next.1.clamp(0., 1.))
    } else {
        next
    };
    let record = positions.entry(key.into()).or_default();
    record.name = name.into();
    match input.dock {
        Dock::Top => record.top = Some(next.0),
        Dock::Left => record.left = Some(next.1),
        Dock::Right => record.right = Some(next.1),
        Dock::Floating => {
            record.floating = Some(NotchFloatingPosition {
                x: next.0,
                y: next.1,
            })
        }
    }
    if commit {
        persist(positions)?;
    }
    Ok(true)
}
fn travel_fraction(delta: f64, available: f64, island: f64) -> f64 {
    let travel = (available - island).max(0.);
    if travel == 0. {
        0.
    } else {
        delta / travel
    }
}

fn notch_positions_path<R: Runtime>(app: &impl Manager<R>) -> Result<PathBuf, String> {
    app.path()
        .resolve("window-state/notch-position.json", BaseDirectory::AppConfig)
        .map_err(|e| e.to_string())
}
pub(crate) fn read_notch_positions<R: Runtime>(app: &impl Manager<R>) -> NotchPositions {
    notch_positions_path(app)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
pub(crate) fn persist_notch_positions<R: Runtime>(
    app: &impl Manager<R>,
    positions: &NotchPositions,
) -> Result<(), String> {
    persist_notch_positions_to_path(&notch_positions_path(app)?, positions)
}
fn persist_notch_positions_to_path(path: &Path, positions: &NotchPositions) -> Result<(), String> {
    // Display-name changes use this same writer and can arrive during a drag.
    // Persist the normalized projection without losing the live pointer overshoot.
    let persisted: NotchPositions = positions
        .iter()
        .map(|(key, record)| {
            let mut record = record.clone();
            record.top = record.top.map(|value| value.clamp(0., 1.));
            record.left = record.left.map(|value| value.clamp(0., 1.));
            record.right = record.right.map(|value| value.clamp(0., 1.));
            record.floating = record.floating.map(|point| NotchFloatingPosition {
                x: point.x.clamp(0., 1.),
                y: point.y.clamp(0., 1.),
            });
            (key.clone(), record)
        })
        .collect();
    let bytes = serde_json::to_vec_pretty(&persisted).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::placement::Rect;
    #[test]
    fn notch_moves_live_but_writes_once_on_commit_for_the_selected_display() {
        use super::super::{
            dock::{Dock, FrameInput, Point},
            placement::Rect,
            DesktopActivityOverlaySurface,
        };
        let mut positions = NotchPositions::new();
        let mut writes = 0;
        for commit in (0..120).map(|_| false).chain(std::iter::once(true)) {
            let position = positions
                .get("studio")
                .and_then(|r| r.floating)
                .unwrap_or(NotchFloatingPosition { x: 0.5, y: 0.5 });
            update_notch_position(
                &mut positions,
                "studio",
                "Studio",
                FrameInput {
                    dock: Dock::Floating,
                    visible: Rect {
                        x: 100.,
                        y: 25.,
                        width: 1440.,
                        height: 825.,
                    },
                    top: 0.,
                    position: (position.x, position.y),
                    extent: (270., 40.),
                    screen_bounds: None,
                    rest_extent: (270., 40.),
                    surface: DesktopActivityOverlaySurface::Collapsed,
                    camera_center: None,
                    camera_offset: 0.,
                },
                None,
                Some(Point {
                    x: if commit { 0. } else { 1. },
                    y: 0.,
                }),
                commit,
                |_| {
                    writes += 1;
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(writes, usize::from(commit));
        }
        let floating = positions["studio"].floating.unwrap();
        assert!((floating.x - (0.5 + 120. / 1170.)).abs() < 1e-12);
        assert_eq!(floating.y, 0.5);
        assert_eq!(positions.len(), 1);
    }

    fn movement_input(dock: Dock, position: (f64, f64)) -> FrameInput {
        FrameInput {
            dock,
            position,
            visible: Rect {
                x: 100.,
                y: 25.,
                width: 1000.,
                height: 800.,
            },
            top: 0.,
            extent: (100., 40.),
            screen_bounds: None,
            rest_extent: (100., 40.),
            surface: super::super::DesktopActivityOverlaySurface::Collapsed,
            camera_center: None,
            camera_offset: 0.,
        }
    }

    #[test]
    fn native_axis_masks_clamp_commits_and_leave_camera_top_fixed() {
        let mut positions = NotchPositions::new();
        for dock in [Dock::Top, Dock::Left, Dock::Right] {
            update_notch_position(
                &mut positions,
                "studio",
                "Studio",
                movement_input(dock, (0.5, 0.5)),
                None,
                Some(Point { x: 900., y: -760. }),
                true,
                |_| Ok(()),
            )
            .unwrap();
        }
        let record = &positions["studio"];
        assert_eq!(
            (record.top, record.left, record.right),
            (Some(1.), Some(0.), Some(0.))
        );
        assert_eq!(record.floating, None);
        let before = positions.clone();
        update_notch_position(
            &mut positions,
            "studio",
            "Studio",
            FrameInput {
                camera_center: Some(600.),
                ..movement_input(Dock::Top, (0.5, 0.5))
            },
            Some(NotchMovePosition::Along(0.2)),
            None,
            true,
            |_| panic!("camera movement cannot persist"),
        )
        .unwrap();
        assert_eq!(positions, before);
    }

    #[test]
    fn pointer_overshoot_preserves_the_grab_until_it_returns_inside_the_edge() {
        let mut positions = NotchPositions::new();
        for (delta, expected_x) in [(900., 1000.), (-90., 1000.), (-450., 910.)] {
            let position = position_for_dock(positions.get("studio"), Dock::Floating);
            let input = movement_input(Dock::Floating, position);
            update_notch_position(
                &mut positions,
                "studio",
                "Studio",
                input,
                None,
                Some(Point { x: delta, y: 0. }),
                false,
                |_| panic!("live drag cannot persist"),
            )
            .unwrap();
            let moved = FrameInput {
                position: position_for_dock(positions.get("studio"), Dock::Floating),
                ..input
            };
            assert!((super::super::dock::frame_plan(moved).rect.x - expected_x).abs() < 1e-9);
        }
        let input = movement_input(
            Dock::Floating,
            position_for_dock(positions.get("studio"), Dock::Floating),
        );
        let mut writes = 0;
        update_notch_position(
            &mut positions,
            "studio",
            "Studio",
            input,
            None,
            Some(Point { x: 900., y: 0. }),
            true,
            |_| {
                writes += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(writes, 1);
        assert_eq!(positions["studio"].floating.unwrap().x, 1.);
    }

    #[test]
    fn display_name_writes_during_a_drag_persist_bounded_fractions_and_keep_live_overshoot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notch-position.json");
        let positions = NotchPositions::from([(
            "studio".into(),
            NotchPositionRecord {
                name: "Renamed Display".into(),
                top: Some(1.5),
                left: Some(-0.2),
                right: Some(0.3),
                floating: Some(NotchFloatingPosition { x: 1.4, y: -0.1 }),
            },
        )]);
        persist_notch_positions_to_path(&path, &positions).unwrap();
        let saved: NotchPositions = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let record = &saved["studio"];
        assert_eq!(
            (record.top, record.left, record.right),
            (Some(1.), Some(0.), Some(0.3))
        );
        assert_eq!(
            record.floating,
            Some(NotchFloatingPosition { x: 1., y: 0. })
        );
        assert_eq!(
            positions["studio"].floating,
            Some(NotchFloatingPosition { x: 1.4, y: -0.1 })
        );
    }
}
