import sharp from "sharp";

type SharpFactory = typeof sharp;

export async function loadSharp(): Promise<SharpFactory> {
    return sharp;
}
