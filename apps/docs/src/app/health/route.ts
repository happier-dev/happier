import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'happier-docs',
    timestamp: new Date().toISOString(),
  });
}

