import type { ImageSource } from 'expo-image';

// Original neutral illustration, not a screenshot of the upstream example.
// Inline SVG is a bundled image source supported by Expo Image on web/iOS/Android.
const staticWebsitePreview = Object.freeze({
  uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#f5f3ee"/><rect x="64" y="46" width="512" height="268" rx="10" fill="#fff" stroke="#292824" stroke-width="2"/><path d="M64 80h512" stroke="#292824" stroke-width="2"/><circle cx="84" cy="63" r="3" fill="#292824"/><circle cx="97" cy="63" r="3" fill="#292824"/><circle cx="110" cy="63" r="3" fill="#292824"/><rect x="100" y="112" width="186" height="16" rx="4" fill="#292824"/><rect x="100" y="148" width="240" height="8" rx="4" fill="#a5a29a"/><rect x="100" y="168" width="204" height="8" rx="4" fill="#a5a29a"/><rect x="100" y="206" width="114" height="34" rx="6" fill="#d9e3d7"/><rect x="386" y="112" width="152" height="128" rx="6" fill="#e6e3dc"/><path d="m413 207 34-37 25 22 21-28 24 43z" fill="#9eaf9b"/><circle cx="492" cy="141" r="10" fill="#c4cfbf"/><rect x="100" y="274" width="438" height="6" rx="3" fill="#e6e3dc"/></svg>')}`,
  width: 640,
  height: 360,
} satisfies ImageSource);

/** Static Project-domain asset data; reading a catalog never loads a remote image. */
export const PROJECT_STARTER_PREVIEW_ASSETS: Readonly<Record<string, ImageSource>> = Object.freeze({
  'project-starter-static-website': staticWebsitePreview,
});
