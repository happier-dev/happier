/** Default surface ink shared by the app themes and standalone public presentations. */
export const HAPPIER_DEFAULT_SURFACE_COLORS: Readonly<Record<'light' | 'dark', Readonly<{
  background: string;
  foreground: string;
  secondary: string;
  link: string;
  border: string;
  /** Accent for Supporter identity marks. Text keeps the normal foreground. */
  supporter: string;
  /** The raised step a control or chip fills with, one step off the background. */
  elevated: string;
}>>> = Object.freeze({
  light: Object.freeze({ background: '#ffffff', foreground: '#222222', secondary: '#6c6c70', link: '#1E778E', border: 'rgba(0, 0, 0, 0.08)', elevated: '#f0f0f0', supporter: '#B07C1C' }),
  dark: Object.freeze({ background: '#1B1919', foreground: '#EFEFEF', secondary: '#9A918C', link: '#9EB9FF', border: 'rgba(255,255,255,0.060)', elevated: '#221C1C', supporter: '#E3B95E' }),
});
