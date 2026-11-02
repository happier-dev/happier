use super::PlatformDisplayFacts;
use ::windows::Win32::Devices::Display::*;
use ::windows::Win32::Foundation::ERROR_SUCCESS;

fn utf16(value: &[u16]) -> String {
    String::from_utf16_lossy(
        &value[..value
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(value.len())],
    )
}

/// QueryDisplayConfig provides the exact GDI source name Tauri exposes; target
/// metadata supplies persistent monitor identity without capture permission.
pub fn platform_display_facts() -> Result<Vec<PlatformDisplayFacts>, String> {
    let (mut path_count, mut mode_count) = (0, 0);
    // SAFETY: all arrays below are allocated to the capacities returned by the
    // API, and every device-info header identifies its complete owning packet.
    unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
            .ok()
            .map_err(|error| error.to_string())?;
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
        .ok()
        .map_err(|error| error.to_string())?;
        paths.truncate(path_count as usize);
        paths
            .into_iter()
            .map(|path| {
                let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                        adapterId: path.sourceInfo.adapterId,
                        id: path.sourceInfo.id,
                    },
                    ..Default::default()
                };
                let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                    header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                        size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                        adapterId: path.targetInfo.adapterId,
                        id: path.targetInfo.id,
                    },
                    ..Default::default()
                };
                for header in [&mut source.header, &mut target.header] {
                    let status = DisplayConfigGetDeviceInfo(header);
                    if status != ERROR_SUCCESS.0 as i32 {
                        return Err(format!("DisplayConfigGetDeviceInfo failed: {status}"));
                    }
                }
                let native_name = utf16(&source.viewGdiDeviceName);
                let device_path = utf16(&target.monitorDevicePath);
                let friendly_name = utf16(&target.monitorFriendlyDeviceName);
                let technology = target.outputTechnology;
                let built_in = if technology == DISPLAYCONFIG_OUTPUT_TECHNOLOGY_OTHER {
                    None
                } else {
                    Some(
                        [
                            DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL,
                            DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS,
                            DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED,
                            DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED,
                        ]
                        .contains(&technology),
                    )
                };
                Ok(PlatformDisplayFacts {
                    storage_key: format!("windows-{device_path}"),
                    native_name,
                    friendly_name: (!friendly_name.is_empty()).then_some(friendly_name),
                    built_in,
                })
            })
            .collect()
    }
}
