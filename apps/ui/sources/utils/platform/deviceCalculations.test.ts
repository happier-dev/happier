import { describe, it, expect } from 'vitest';
import { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight } from './deviceCalculations';

describe('responsive utilities', () => {
    describe('calculateDeviceDimensions', () => {
        it('returns basic viewport metrics (iPhone 13 points)', () => {
            // iPhone 13: 390x844 points
            const result = calculateDeviceDimensions({
                widthPoints: 390,
                heightPoints: 844,
            });

            expect(result.minEdgePoints).toBe(390);
            expect(result.maxEdgePoints).toBe(844);
            expect(result.diagonalPoints).toBeCloseTo(Math.sqrt(390 * 390 + 844 * 844), 6);
        });

        it('returns min/max edges regardless of orientation', () => {
            const result = calculateDeviceDimensions({
                widthPoints: 1194,
                heightPoints: 834,
            });

            expect(result.minEdgePoints).toBe(834);
            expect(result.maxEdgePoints).toBe(1194);
        });

        it('handles non-finite inputs conservatively', () => {
            const result = calculateDeviceDimensions({
                widthPoints: Number.NaN,
                heightPoints: 800,
            });

            expect(result.minEdgePoints).toBe(0);
            expect(result.maxEdgePoints).toBe(800);
        });
    });

    describe('determineDeviceType', () => {
        it('treats iOS iPads as tablets (don’t special-case iPad mini)', () => {
            const result = determineDeviceType({
                platform: 'ios',
                isPad: true,
                widthPoints: 744,
                heightPoints: 1133,
            });

            expect(result).toBe('tablet');
        });

        it('treats iOS iPads as phones when the window is narrow (split view)', () => {
            const result = determineDeviceType({
                platform: 'ios',
                isPad: true,
                widthPoints: 390,
                heightPoints: 1133,
            });

            expect(result).toBe('phone');
        });

        it('treats iOS phones as phones', () => {
            const result = determineDeviceType({
                platform: 'ios',
                isPad: false,
                widthPoints: 390,
                heightPoints: 844,
            });

            expect(result).toBe('phone');
        });

        it('uses min edge threshold on Android', () => {
            const result = determineDeviceType({
                platform: 'android',
                widthPoints: 800,
                heightPoints: 1280,
            });

            expect(result).toBe('tablet');
        });

        it('treats Android phones as phones', () => {
            const result = determineDeviceType({
                platform: 'android',
                widthPoints: 360,
                heightPoints: 800,
            });

            expect(result).toBe('phone');
        });

        it('uses min edge threshold on web to avoid landscape-phone false positives', () => {
            expect(determineDeviceType({
                platform: 'web',
                widthPoints: 800,
                heightPoints: 600,
            })).toBe('tablet');

            expect(determineDeviceType({
                platform: 'web',
                widthPoints: 812,
                heightPoints: 375,
            })).toBe('phone');
        });

        it('respects custom min-edge threshold and handles exact edge', () => {
            const result = determineDeviceType({
                platform: 'android',
                widthPoints: 600,
                heightPoints: 900,
                tabletMinEdgePoints: 600,
            });

            expect(result).toBe('tablet');
        });
    });

    describe('calculateHeaderHeight', () => {
        it('should return correct height for Android phone in portrait', () => {
            const height = calculateHeaderHeight({
                platform: 'android',
                deviceType: 'phone',
                isLandscape: false
            });
            expect(height).toBe(56);
        });

        it('should return correct height for Android phone in landscape', () => {
            const height = calculateHeaderHeight({
                platform: 'android',
                deviceType: 'phone',
                isLandscape: true
            });
            expect(height).toBe(48);
        });

        it('should return correct height for Android tablet', () => {
            const height = calculateHeaderHeight({
                platform: 'android',
                deviceType: 'tablet',
                isLandscape: false
            });
            expect(height).toBe(64);
        });

        it('should return correct height for iOS iPhone', () => {
            const height = calculateHeaderHeight({
                platform: 'ios',
                isPad: false,
                isLandscape: false
            });
            expect(height).toBe(44);
        });

        it('should return correct height for iOS iPad', () => {
            const height = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                isLandscape: false
            });
            expect(height).toBe(50);
        });

        it('should ignore landscape for iOS devices', () => {
            const iPhonePortrait = calculateHeaderHeight({
                platform: 'ios',
                isPad: false,
                isLandscape: false
            });
            const iPhoneLandscape = calculateHeaderHeight({
                platform: 'ios',
                isPad: false,
                isLandscape: true
            });
            expect(iPhonePortrait).toBe(iPhoneLandscape);

            const iPadPortrait = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                isLandscape: false
            });
            const iPadLandscape = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                isLandscape: true
            });
            expect(iPadPortrait).toBe(iPadLandscape);
        });

        it('should use isPad for iOS and ignore deviceType', () => {
            // Even if deviceType says phone, if isPad is true, should return iPad height
            const height = calculateHeaderHeight({
                platform: 'ios',
                isPad: true,
                deviceType: 'phone', // This should be ignored
                isLandscape: false
            });
            expect(height).toBe(50);
        });

        it('should return dedicated heights for web and Mac Catalyst', () => {
            expect(calculateHeaderHeight({
                platform: 'web',
                isLandscape: false
            })).toBe(56);

            expect(calculateHeaderHeight({
                platform: 'ios',
                isLandscape: false,
                isMacCatalyst: true
            })).toBe(56);
        });
    });
});
