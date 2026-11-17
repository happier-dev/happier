import type { SupportedLanguage } from '../_all';

export type SimulatorDeviceToolsCopy = Readonly<{
  start: string;
  stopped: string;
  powerOff: string;
  screenshot: string;
  operationFailed: string;
  videoUnsupported: string;
  videoUnsupportedBody: string;
  appSection: string;
  appDescription: string;
  appId: string;
  launch: string;
  terminate: string;
  linkSection: string;
  url: string;
  open: string;
  settingsSection: string;
  appearance: string;
  light: string;
  dark: string;
  textSize: string;
  small: string;
  defaultSize: string;
  large: string;
  orientation: string;
  portrait: string;
  landscape: string;
  location: string;
  latitude: string;
  longitude: string;
  setLocation: string;
  clearLocation: string;
  permissions: string;
  permissionsDescription: string;
  permission: string;
  allow: string;
  deny: string;
  reset: string;
  camera: string;
  photos: string;
  microphone: string;
  contacts: string;
  locationPermission: string;
  push: string;
  pushDescription: string;
  payload: string;
  send: string;
  invalidJson: string;
  needAppId: string;
  accessibility: string;
  accessibilityDescription: string;
  readScreen: string;
  press: string;
  truncated: string;
  noElements: string;
}>;

/** Copy for the device viewer's device operations: lifecycle, screenshot, app, link, settings and accessibility. */
export const simulatorDeviceToolsTranslations = {
  "en": {
    start: "Start",
    stopped: "Stopped",
    powerOff: "Power off",
    screenshot: "Take screenshot",
    operationFailed: "That didn’t work on the device",
    videoUnsupported: "Video can’t play here",
    videoUnsupportedBody: "This browser can’t decode the device’s video. Open Happier in a current Chrome, Edge or Safari, or in the app.",
    appSection: "App",
    appDescription: "Launch or stop an app by its bundle or package ID.",
    appId: "App ID",
    launch: "Launch",
    terminate: "Stop",
    linkSection: "Open a link",
    url: "URL or deep link",
    open: "Open",
    settingsSection: "Device settings",
    appearance: "Appearance",
    light: "Light",
    dark: "Dark",
    textSize: "Text size",
    small: "Small",
    defaultSize: "Default",
    large: "Large",
    orientation: "Orientation",
    portrait: "Portrait",
    landscape: "Landscape",
    location: "Location",
    latitude: "Latitude",
    longitude: "Longitude",
    setLocation: "Set",
    clearLocation: "Clear",
    permissions: "Permissions",
    permissionsDescription: "Change what the app above may use.",
    permission: "Permission",
    allow: "Allow",
    deny: "Deny",
    reset: "Reset",
    camera: "Camera",
    photos: "Photos",
    microphone: "Microphone",
    contacts: "Contacts",
    locationPermission: "Location",
    push: "Push notification",
    pushDescription: "Sends to the app above.",
    payload: "Payload (JSON)",
    send: "Send",
    invalidJson: "Enter a JSON object.",
    needAppId: "Enter an app ID first.",
    accessibility: "Accessibility",
    accessibilityDescription: "The elements on screen, as assistive technology reads them.",
    readScreen: "Read screen",
    press: "Press",
    truncated: "Showing part of the screen.",
    noElements: "No elements found.",
  },
} as const satisfies Pick<Record<SupportedLanguage, SimulatorDeviceToolsCopy>, 'en'>;
