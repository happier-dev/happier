/** React Native's untyped colour boundary returns unsigned RGBA, or null for unsupported values. */
declare module '@react-native/normalize-colors' {
    export default function normalizeColor(color: string | number): number | null;
}
