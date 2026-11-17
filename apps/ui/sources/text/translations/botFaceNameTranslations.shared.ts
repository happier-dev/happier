import type { BotFaceBody, BotFacePalette } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

// The names the face picker shows for each body and colour, keyed by the protocol catalogs, so a new body or
// colour fails the typecheck in every locale until it is named.
export type BotFaceNames = Readonly<{
  accountDefault: string;
  bodies: Readonly<Record<BotFaceBody, string>>;
  colours: Readonly<Record<BotFacePalette, string>>;
}>;

export const botFaceNameTranslations = {
  en: {
    accountDefault: 'Account default',
    bodies: { crab: "Crab", squid: "Squid", octopus: "Octopus", ufo: "Saucer", specter: "Specter", ghost: "Ghost", beetle: "Beetle", spider: "Spider", jelly: "Jelly", hopper: "Hopper", pup: "Pup", drone: "Drone", robot: "Robot", walker: "Walker", rocket: "Rocket", feet: "Feet", tail: "Tail", drip: "Drip", bracelegs: "Brace legs", tagclaws: "Tag claws", cursortail: "Cursor tail", termbody: "Terminal", antlers: "Branch antlers", semi: "Semicolon", brackets: "Brackets", cursor: "Cursor", bean: "Bean", squat: "Squat", bag: "Bag", loaf: "Loaf", puddle: "Puddle", tower: "Tower", stilts: "Stilts", tall: "Tall", cat: "Cat" },
    colours: { daybreak: "Daybreak", lagoon: "Lagoon", orchid: "Orchid", aurora: "Aurora", indigo: "Indigo", glacier: "Glacier", moss: "Moss", sand: "Sand", ink: "Ink" },
  },
} as const satisfies Pick<Readonly<Record<string, BotFaceNames>>, 'en'>;
