import type { BotFaceBodyArt } from './botFaceArt';
import { BOT_FACE_MOUTHS, botFaceGeometry, botFaceMouthLine, botFaceMouthPoints, botFaceSd, type BotFaceMood } from './botFaceGeometry';

/** R8 outline fallback only. Roster bodies keep their hand-drawn sprites. */
export function deriveBotFaceSprite(art: BotFaceBodyArt, mood: BotFaceMood, width: 8 | 12) {
  const G = botFaceGeometry('', art, true);
  const x0 = -G.hw, cell = 2 * G.hw / width, y0 = G.top;
  const rows = Math.max(3, Math.round((G.bot - G.top) / cell));
  const grid: string[][] = [];
  for (let row = 0; row < rows; row++) {
    const pixels: string[] = [];
    for (let col = 0; col < width; col++) {
      let hits = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        if (botFaceSd(G, x0 + (col + (x + 0.5) / 4) * cell, y0 + (row + (y + 0.5) / 4) * cell) < 0) hits++;
      }
      pixels.push(hits >= 7 ? 'X' : '.');
    }
    grid.push(pixels);
  }
  const mouth = BOT_FACE_MOUTHS[mood];
  const line = botFaceMouthLine(botFaceMouthPoints(G, mouth), mouth.o);
  const carve = new Set<string>();
  for (let i = 1; i < line.length; i++) for (let step = 0; step <= 10; step++) {
    const t = step / 10;
    const x = line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t;
    const y = line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t;
    carve.add(`${Math.floor((y - y0) / cell)}|${Math.floor((x - x0) / cell)}`);
  }
  let first = rows, last = 0;
  for (const key of carve) {
    const [row, col] = key.split('|').map(Number);
    if (grid[row]?.[col] !== 'X') continue;
    const neighbours = [grid[row - 1]?.[col], grid[row + 1]?.[col], grid[row][col - 1], grid[row][col + 1]];
    if (neighbours.filter(value => value === 'X' || value === 'o').length < 2) continue;
    grid[row][col] = 'o'; first = Math.min(first, row); last = Math.max(last, row);
  }
  return { grid: grid.map(row => row.join('').replace(/o/g, '.')), mouthRow: first, mouthRows: Math.max(0, last - first + 1) };
}
