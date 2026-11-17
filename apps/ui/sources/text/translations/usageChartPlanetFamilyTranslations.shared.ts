import { PUBLIC_USAGE_PLANET_COPY_EN } from '@happier-dev/protocol/account/publicProfilePresentationCopy';

// Copy for the calendar and planet-family Usage chart bodies (Ninety planets, Streak thread, Weeks, Days on the
// surface, Ringed by streaks, Around the period, Moons, Machines, Projects, Atmosphere).
type Count = { count: string | number };
type CountTotal = { count: string | number; total: string | number };

export const block = (copy: {
  levelColumn: string;
  weekColumn: string;
  activeDaysColumn: string;
  shareColumn: string;
  daysColumn: string;
  peakColumn: string;
  kindColumn: string;
  countColumn: string;
  weekdayInitials: string;
  streakBestDays: (p: Count) => string;
  streakNowDays: (p: Count) => string;
  streakOngoingBest: (p: Count) => string;
  daysLit: (p: CountTotal) => string;
  noStreakRings: string;
  partialWeek: (p: { from: string; to: string }) => string;
  moonsCaption: string;
  moonsCaptionDays: string;
  machinesUnavailable: string;
  machinesEmpty: string;
  machineKindUnknown: string;
  projectsEmpty: string;
  atmosphereFirstWeek: string;
  atmosphereCaption: string;
  atmosphereCaptionPeak: (p: Count) => string;
}) => copy;

export const usageChartPlanetFamilyTranslations = {
  en: block(PUBLIC_USAGE_PLANET_COPY_EN),
} as const;
