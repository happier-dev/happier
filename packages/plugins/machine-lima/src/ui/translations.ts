import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"VM","description":"A light Linux VM for code, scripts and dev servers.","ready":"Installed","unavailable":"Not installed","lima_2_required":"Lima 2 required","qemu_unavailable":"QEMU unavailable","qemu_driver_unavailable":"QEMU unavailable","vz_driver_unavailable":"Virtualization unavailable"},
  "de": {"kind":"VM","description":"Eine leichte Linux-VM für Code, Skripte und Entwicklungsserver.","ready":"Installiert","unavailable":"Nicht installiert","lima_2_required":"Lima 2 erforderlich","qemu_unavailable":"QEMU nicht verfügbar","qemu_driver_unavailable":"QEMU nicht verfügbar","vz_driver_unavailable":"Virtualisierung nicht verfügbar"},
  "ru": {"kind":"ВМ","description":"Лёгкая ВМ Linux для кода, скриптов и серверов разработки.","ready":"Установлено","unavailable":"Не установлено","lima_2_required":"Требуется Lima 2","qemu_unavailable":"QEMU недоступен","qemu_driver_unavailable":"QEMU недоступен","vz_driver_unavailable":"Виртуализация недоступна"},
  "pl": {"kind":"VM","description":"Lekka maszyna Linux do kodu, skryptów i serwerów programistycznych.","ready":"Zainstalowano","unavailable":"Nie zainstalowano","lima_2_required":"Wymagane Lima 2","qemu_unavailable":"QEMU niedostępne","qemu_driver_unavailable":"QEMU niedostępne","vz_driver_unavailable":"Wirtualizacja niedostępna"},
  "es": {"kind":"VM","description":"Una VM Linux ligera para código, scripts y servidores de desarrollo.","ready":"Instalado","unavailable":"No instalado","lima_2_required":"Se requiere Lima 2","qemu_unavailable":"QEMU no disponible","qemu_driver_unavailable":"QEMU no disponible","vz_driver_unavailable":"Virtualización no disponible"},
  "fr": {"kind":"VM","description":"Une VM Linux légère pour le code, les scripts et les serveurs de développement.","ready":"Installé","unavailable":"Non installé","lima_2_required":"Lima 2 requis","qemu_unavailable":"QEMU indisponible","qemu_driver_unavailable":"QEMU indisponible","vz_driver_unavailable":"Virtualisation indisponible"},
  "it": {"kind":"VM","description":"Una VM Linux leggera per codice, script e server di sviluppo.","ready":"Installato","unavailable":"Non installato","lima_2_required":"Richiesto Lima 2","qemu_unavailable":"QEMU non disponibile","qemu_driver_unavailable":"QEMU non disponibile","vz_driver_unavailable":"Virtualizzazione non disponibile"},
  "pt": {"kind":"VM","description":"Uma VM Linux leve para código, scripts e servidores de desenvolvimento.","ready":"Instalado","unavailable":"Não instalado","lima_2_required":"Lima 2 necessário","qemu_unavailable":"QEMU indisponível","qemu_driver_unavailable":"QEMU indisponível","vz_driver_unavailable":"Virtualização indisponível"},
  "ca": {"kind":"VM","description":"Una VM Linux lleugera per a codi, scripts i servidors de desenvolupament.","ready":"Instal·lat","unavailable":"No instal·lat","lima_2_required":"Cal Lima 2","qemu_unavailable":"QEMU no disponible","qemu_driver_unavailable":"QEMU no disponible","vz_driver_unavailable":"Virtualització no disponible"},
  "zh-Hans": {"kind":"虚拟机","description":"用于代码、脚本和开发服务器的轻量 Linux 虚拟机。","ready":"已安装","unavailable":"未安装","lima_2_required":"需要 Lima 2","qemu_unavailable":"QEMU 不可用","qemu_driver_unavailable":"QEMU 不可用","vz_driver_unavailable":"虚拟化不可用"},
  "zh-Hant": {"kind":"虛擬機","description":"用於程式碼、腳本和開發伺服器的輕量 Linux 虛擬機。","ready":"已安裝","unavailable":"未安裝","lima_2_required":"需要 Lima 2","qemu_unavailable":"QEMU 不可用","qemu_driver_unavailable":"QEMU 不可用","vz_driver_unavailable":"虛擬化不可用"},
  "ja": {"kind":"VM","description":"コード、スクリプト、開発サーバー向けの軽量 Linux VM。","ready":"インストール済み","unavailable":"未インストール","lima_2_required":"Lima 2 が必要","qemu_unavailable":"QEMU 利用不可","qemu_driver_unavailable":"QEMU 利用不可","vz_driver_unavailable":"仮想化利用不可"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PluginLocalizedStringV2 {
  return { key: 'machineLima.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}

export const LIMA_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = Object.entries(MACHINE_PRESENTATION_LABELS).map(([locale, labels]) => ({
  locale, messages: Object.fromEntries(Object.entries(labels).map(([id, value]) => ['machineLima.presentation.' + id, value])),
}));
